import path from 'path'

import { NoteCommitmentTree } from '@railgun-reloaded/note-commitment-indexer'
import type { ChainDB, DBNewCommitment, DBNewNullifier } from '@railgun-reloaded/storage'
import { createChainDB, getCommitmentsByBlockRange, getSyncState, insertCommitmentBatch, insertNullifiersBatch, updateSyncState } from '@railgun-reloaded/storage'
import type { EVMBlock, SourceAggregator } from 'scanner'

import { denormalizeBlockData } from './event-denormalizer'
import { createDirectoryIfNotExists } from './fs-utils'
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
        createDirectoryIfNotExists(dirName)

        this.#db = createChainDB({
          path: path.join(dirName, 'chain.db'),
          runMigrations: true
        })
      }

      const lastSycedBlock = getSyncState(this.#db, this.#networkConfig.chainID)?.lastBlockHeight
      this.#startDataSync(lastSycedBlock ?? this.#networkConfig.deploymentBlock)
    } catch (err) {
      console.log(err)
    }
  }

  /**
   * Start Scanner in the background
   * @param startHeight - Starting Height for fetching data
   */
  async #startDataSync (startHeight: bigint) {
    this.#log(`Syncing event from height ${startHeight}`)
    const eventIterator = this.#dataSource.from({
      startHeight,
    })

    /**
     * Insert Batched data to the table
     * @param nullifierBatch - Batched Nullifiers to insert
     * @param commitmentBatch - Batched Commitments to insert
     * @param blockNumber - Block number of last batched entry
     */
    const insertBatch = (nullifierBatch: DBNewNullifier[], commitmentBatch: DBNewCommitment[], blockNumber: bigint) => {
      // We insert in batch to reduce the cost of updating database
      const intsertedNullifiers = insertNullifiersBatch(this.#db!, nullifierBatch)
      const insertedCommitments = insertCommitmentBatch(this.#db!, commitmentBatch)
      updateSyncState(this.#db!, this.#networkConfig.chainID, blockNumber)
      this.#log(`Inserting batch, blockNumber:${blockNumber}, Nullifiers: ${intsertedNullifiers}, Commitments: ${insertedCommitments}`)

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

        const root = Buffer.from(this.#noteCommitmentTree.get(key)!.root()).toString('hex')
        this.#log(`TreeNumber: ${key} MerkleRoot: 0x${root}`)
      }
    }

    // Batch size, when reached should update the DB
    // This is to reduce the DB load by updating entries in batch
    const batchInsertSize = 100
    let nullifierBatch = []
    let commitmentBatch = []

    let totalBlocks = 0
    let lastBlockNumber = 0n
    for await (const block of eventIterator) {
      const { nullifiers, commitments } = denormalizeBlockData(block)
      nullifierBatch.push(...nullifiers)
      commitmentBatch.push(...commitments)
      totalBlocks += 1

      if (totalBlocks > batchInsertSize) {
        insertBatch(nullifierBatch, commitmentBatch, block.number)
        totalBlocks = 0
        nullifierBatch = []
        commitmentBatch = []
      }
      lastBlockNumber = block.number
    }

    if (totalBlocks > 0) {
      insertBatch(nullifierBatch, commitmentBatch, lastBlockNumber)
    }

    const totalCommitments = getCommitmentsByBlockRange(this.#db!, this.#networkConfig.deploymentBlock!, lastBlockNumber)
    console.log(totalCommitments.length)
  }

  /**
   * Get Chain DB Instance
   * @returns ChainDB Instance
   */
  get db () {
    return this.#db
  }

  /**
   * Destroy Railgun Engine
   */
  destroy () {
    this.#dataSource.destroy()
  }
}

export { RailgunEngine }
