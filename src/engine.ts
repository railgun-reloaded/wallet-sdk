import { existsSync, mkdirSync } from 'fs'
import path from 'path'

import type { ChainDB, DBNewCommitment, DBNewNullifier, DBNewUnshield } from '@railgun-reloaded/storage'
import { closeChainDB, createChainDB, getMerkleTree, getSyncState, insertCommitmentBatch, insertNullifiersBatch, insertUnshieldBatch, runDBTransaction, setMerkleTree, updateSyncState } from '@railgun-reloaded/storage'
import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'

import { denormalizeBlockData } from './event-denormalizer'
import { NoteCommitmentTree } from './merkle'
import type { NetworkConfig, NetworkName } from './network-config'
import { NETWORK_CONFIG } from './network-config'
/**
 * RailgunEngine
 *
 * Core orchestrator for the Railgun protocol. Manages initialization and lifecycle
 * of all critical components required for Railgun operation like
 * - Prover: Cryptographic proof generation engine
 * - DataSync: Blockchain data synchronization service
 * - ArtifactFetcher: Resource and artifact retrieval service
 */
class RailgunEngine {
/**
 * The Source Aggregator manages multiple data sources used for data synchronization.
 *
 * Data sources are organized hierarchically based on retrieval cost.
 * The system prioritizes lower-cost sources (such as Snapshot and Subsquid)
 * and progressively falls back to higher-cost sources (such as RPC)
 * when necessary.
 */
  #dataSource!: SourceAggregator<EVMBlock>

  /**
   * Optional Logger Function
   */
  #log: (message: string) => void = console.log

  /**
   * Currently selected network
   */
  #currentNetwork!: NetworkName

  /**
   * NetworkConfig for currently selected network
   */
  #networkConfig!: NetworkConfig

  /**
   * Database Instance to store chain related data
   */
  #db: ChainDB | undefined

  /**
   * Note Commitment Merkle Tree
   */
  #noteCommitmentTree = new Map<number, NoteCommitmentTree>()

  /**
   * Timeout value for controlling eventSync
   */
  #eventSyncTimeout: NodeJS.Timeout | null = null

  /**
   * Flag to indicate if we should stop eventSync
   */
  #shouldStopEventSync = false

  /**
   * Set Aggregated Data Source for the engine
   * @param dataSource - Input source aggregator
   */
  setDataSource (dataSource: SourceAggregator<EVMBlock>) {
    if (this.#dataSource) {
      this.#dataSource.destroy()
    }
    this.#dataSource = dataSource
  }

  /**
   * Set current network for engine
   * @param networkName - Input Network Name
   */
  setNetwork (networkName: NetworkName) {
    this.#currentNetwork = networkName
  }

  /**
   * Set Logger for Railgun Engine
   * @param log - Logger Function
   */
  setLogger (log: (msg: string) => void) {
    this.#log = log
  }

  /**
   * Start Railgun Engine, This initializes all the necessary components
   * in order.
   */
  start () {
    if (!this.#currentNetwork) {
      throw new Error('Initialization Failed: No valid network selected')
    }
    this.#log(`EngineInit:: Initializing for Network ${this.#currentNetwork}`)

    if (!this.#dataSource) {
      throw new Error('Initialization Failed: Invalid data source')
    }

    this.#networkConfig = NETWORK_CONFIG[this.#currentNetwork]
    try {
      if (!this.#db) {
        const dirName = `./.railgun/chains/${this.#networkConfig.chainID}/`
        if (!existsSync(dirName)) {
          mkdirSync(dirName, { recursive: true })
        }

        this.#db = createChainDB({
          path: path.join(dirName, 'chain.db'),
          runMigrations: true
        })
      }

      // Load existing merkleTree from the DB
      this.#loadMerkleTree()

      const lastSycedBlock = getSyncState(this.#db, this.#networkConfig.chainID)?.lastBlockHeight
      const startHeight = lastSycedBlock ? lastSycedBlock + 1n : this.#networkConfig.deploymentBlock
      this.#startDataSync(startHeight)
    } catch (err) {
      console.log(err)
    }
  }

  /**
   * Load merkletree from the DB
   */
  #loadMerkleTree () {
    let treeNumber = 0
    // @TODO replace this by getAllMerkleTree query, should be added in the reloaded/storage
    while (true) {
      const treeEntry = getMerkleTree(this.#db!, treeNumber)
      if (treeEntry) {
        this.#noteCommitmentTree.set(treeNumber, new NoteCommitmentTree({
          buffer: treeEntry.leaves,
          length: treeEntry.leafCount
        }))
        treeNumber++
      } else {
        return
      }
    }
  }

  /**
   * Insert Batched data to the table
   * @param nullifierBatch - Batched Nullifiers to insert
   * @param commitmentBatch - Batched Commitments to insert
   * @param unshieldBatch - Batched Unshields to insert
   * @param blockNumber - Block number of last batched entry
   */
  #insertBatch (nullifierBatch: DBNewNullifier[], commitmentBatch: DBNewCommitment[], unshieldBatch: DBNewUnshield[], blockNumber: bigint) {
    // Update commitmentTree
    const treeSortedCommitments = new Map<number, { treePosition: number, hash: Uint8Array }[]>()
    commitmentBatch.forEach((c) => {
      const { treeNumber, treePosition, hash } = c
      if (!treeSortedCommitments.has(treeNumber)) {
        treeSortedCommitments.set(treeNumber, [{ treePosition, hash: hash as Uint8Array }])
      } else {
        treeSortedCommitments.get(treeNumber)!.push({ treePosition, hash: hash as Uint8Array })
      }
    })

    for (const [key, val] of treeSortedCommitments) {
      if (!this.#noteCommitmentTree.has(key)) {
        this.#noteCommitmentTree.set(key, new NoteCommitmentTree())
      }
      const commitments = val.sort((a, b) => a.treePosition - b.treePosition)
      if (commitments.length > 0) {
        this.#noteCommitmentTree.get(key)!.append(commitments.map(c => c.hash))
      }
    }

    runDBTransaction(this.#db!, (tx) => {
      // We insert in batch to reduce the cost of updating database
      if (nullifierBatch.length > 0) {
        insertNullifiersBatch(tx, nullifierBatch)
      }
      if (commitmentBatch.length > 0) {
        insertCommitmentBatch(tx, commitmentBatch)
      }
      if (unshieldBatch.length > 0) {
        insertUnshieldBatch(tx, unshieldBatch)
      }

      updateSyncState(tx, this.#networkConfig.chainID, blockNumber)

      for (const [key] of treeSortedCommitments) {
        const tree = this.#noteCommitmentTree.get(key)!
        const { length, buf } = tree.merkleTree.serialize()
        setMerkleTree(tx, {
          treeNumber: key,
          leafCount: length,
          leaves: buf
        })
      }
    })
  }

  /**
   * Start Scanner in the background
   * @param startHeight - Starting Height for fetching data
   */
  async #startDataSync (startHeight: bigint) {
    if (this.#shouldStopEventSync) return

    this.#log(`Syncing event from height ${startHeight}`)
    const eventIterator = this.#dataSource.from({
      startHeight,
    })

    // Batch size, when reached should update the DB
    // This is to reduce the DB load by updating entries in batch
    const batchInsertSize = 100
    let nullifierBatch = []
    let commitmentBatch = []
    let unshieldBatch = []

    let totalBlocks = 0
    let lastBlockNumber = startHeight
    for await (const block of eventIterator) {
      const { nullifiers, commitments, unshields } = denormalizeBlockData(block)
      nullifierBatch.push(...nullifiers)
      commitmentBatch.push(...commitments)
      unshieldBatch.push(...unshields)
      totalBlocks += 1

      if (totalBlocks > batchInsertSize) {
        this.#insertBatch(nullifierBatch, commitmentBatch, unshieldBatch, block.number)
        totalBlocks = 0
        commitmentBatch = []
        nullifierBatch = []
        unshieldBatch = []
      }
      lastBlockNumber = block.number
    }
    if (totalBlocks > 0) {
      this.#insertBatch(nullifierBatch, commitmentBatch, unshieldBatch, lastBlockNumber)
    }
    // This is a temporary solution for liveSync, every 10s it schedules new  iterator for syncing data.
    // This should be removed in favor of RPCProvider
    // Also lastBlockNumber should the actual block number returned by the dataSync, instead of last insertedBlock
    this.#eventSyncTimeout = setTimeout(this.#startDataSync.bind(this), 10_000, lastBlockNumber === startHeight ? lastBlockNumber : lastBlockNumber + 1n)
  }

  /**
   * Get Chain DB Instance
   * @returns ChainDB Instance
   */
  get db () {
    return this.#db
  }

  /**
   * Get MerkleTree by treeNumber
   * @param treeNumber - Input treeNumber
   * @returns - NoteCommitmentTree instance
   */
  getNoteCommitmentTreeByTreeNumber (treeNumber: number) {
    if (!this.#noteCommitmentTree.has(treeNumber)) {
      throw new Error(`NoteCommitmentMerkleTree not found for treeNumber ${treeNumber}`)
    }
    return this.#noteCommitmentTree.get(treeNumber)!
  }

  /**
   * Get all the note commitment tree in the engine
   * @returns - Map of treeNumber with corresponding NoteCommitmentTree instance
   */
  getAllNoteCommitmentTree () {
    return this.#noteCommitmentTree
  }

  /**
   * Destroy Railgun Engine
   */
  destroy () {
    this.#shouldStopEventSync = true
    if (this.#eventSyncTimeout) {
      clearTimeout(this.#eventSyncTimeout)
      this.#eventSyncTimeout = null
    }
    closeChainDB(this.#db!)
    this.#dataSource.destroy()
  }
}

export { RailgunEngine }
