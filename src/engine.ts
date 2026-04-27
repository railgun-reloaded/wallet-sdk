import { existsSync, mkdirSync } from 'fs'
import path from 'path'

import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'
import type { ChainDB, DBNewCommitment, DBNewNullifier, DBNewUnshield } from '@railgun-reloaded/storage'
import { closeChainDB, createChainDB, getAllMerkleTrees, getSyncState, insertCommitmentBatch, insertNullifiersBatch, insertUnshieldBatch, runDBTransaction, setMerkleTree, updateSyncState } from '@railgun-reloaded/storage'

import { NoteCommitmentTree } from './merkle'
import type { NetworkConfig, NetworkName } from './network-config'
import { NETWORK_CONFIG } from './network-config'
import { denormalizeBlockData } from './sync'
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
   * Drain the configured data source into chain.db, returning when the source
   * reaches its current tip. Resumes from the persisted sync cursor when one
   * exists, otherwise starts at the network's deployment block.
   *
   * Live sources (RPCProvider) never reach a natural tip; bound the scan with
   * `endBlock` when using one.
   * @param options - Optional `{ endBlock? }` to bound the scan height.
   * @param options.endBlock - Inclusive ceiling; the scan exits after writing
   *   a block at or above this height.
   * @returns Last block number written to chain.db, or `undefined` when the
   *   source had nothing to yield.
   */
  async scan (options: { endBlock?: bigint } = {}): Promise<bigint | undefined> {
    if (!this.#currentNetwork) {
      throw new Error('Scan failed: no network selected')
    }
    if (!this.#dataSource) {
      throw new Error('Scan failed: no data source set')
    }

    this.#networkConfig = NETWORK_CONFIG[this.#currentNetwork]
    this.#log(`EngineInit:: Initializing for Network ${this.#currentNetwork}`)

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

    this.#loadMerkleTree()

    const lastSyncedBlock = getSyncState(this.#db, this.#networkConfig.chainID)?.lastBlockHeight
    const startHeight = lastSyncedBlock ? lastSyncedBlock + 1n : this.#networkConfig.deploymentBlock

    return this.#drainToTip(startHeight, options.endBlock)
  }

  /**
   * Load all persisted merkle trees from chain.db into the in-memory map.
   * Trees are returned ordered by treeNumber, so map insertion order matches
   * on-disk order.
   */
  #loadMerkleTree () {
    for (const tree of getAllMerkleTrees(this.#db!)) {
      this.#noteCommitmentTree.set(tree.treeNumber, new NoteCommitmentTree({
        buffer: tree.leaves,
        length: tree.leafCount
      }))
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
   * Drive the data source iterator from `startHeight` until it terminates,
   * batching writes to chain.db. Stops early when a block at `endBlock` (or
   * past it) has been ingested. Returns the last block number written, or
   * `undefined` when the iterator yielded nothing.
   * @param startHeight - Block to begin syncing from (inclusive).
   * @param endBlock - Optional ceiling; the loop exits after writing a block
   *   at or above this height.
   * @returns Last block number persisted, or `undefined`.
   */
  async #drainToTip (startHeight: bigint, endBlock?: bigint): Promise<bigint | undefined> {
    this.#log(`Syncing event from height ${startHeight}`)
    const eventIterator = this.#dataSource.from({
      startHeight,
      endHeight: endBlock,
      liveSync: false,
    })

    const batchInsertSize = 100
    let nullifierBatch: DBNewNullifier[] = []
    let commitmentBatch: DBNewCommitment[] = []
    let unshieldBatch: DBNewUnshield[] = []

    let blocksInBatch = 0
    let lastBlockNumber: bigint | undefined
    for await (const block of eventIterator) {
      const { nullifiers, commitments, unshields } = denormalizeBlockData(block)
      nullifierBatch.push(...nullifiers)
      commitmentBatch.push(...commitments)
      unshieldBatch.push(...unshields)
      blocksInBatch += 1
      lastBlockNumber = block.number

      if (blocksInBatch >= batchInsertSize) {
        this.#insertBatch(nullifierBatch, commitmentBatch, unshieldBatch, block.number)
        blocksInBatch = 0
        commitmentBatch = []
        nullifierBatch = []
        unshieldBatch = []
      }

      if (endBlock !== undefined && block.number >= endBlock) {
        break
      }
    }

    if (blocksInBatch > 0 && lastBlockNumber !== undefined) {
      this.#insertBatch(nullifierBatch, commitmentBatch, unshieldBatch, lastBlockNumber)
    }

    return lastBlockNumber
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
   * Release engine resources: close chain.db and tear down the data source.
   */
  destroy () {
    if (this.#db) {
      closeChainDB(this.#db)
    }
    if (this.#dataSource) {
      this.#dataSource.destroy()
    }
  }
}

export { RailgunEngine }
