import { existsSync, mkdirSync } from 'fs'
import path from 'path'

import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'
import type { ChainStorage } from '@railgun-reloaded/storage'
import type { ChainDB } from '@railgun-reloaded/storage/node'
import { closeChainDB, createChainDB, createChainStorage } from '@railgun-reloaded/storage/node'

import type { NoteCommitmentTree } from './merkle/index.js'
import type { NetworkConfig, NetworkName } from './network-config.js'
import { NETWORK_CONFIG } from './network-config.js'
import { drainChainToTip, loadMerkleTrees } from './sync/chain-sync.js'
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
   * Currently selected network. `undefined` until `setNetwork()` is called.
   */
  #currentNetwork: NetworkName | undefined

  /**
   * NetworkConfig for currently selected network
   */
  #networkConfig!: NetworkConfig

  /**
   * Database Instance to store chain related data
   */
  #db: ChainDB | undefined

  /**
   * ChainStorage contract bound to the current chain DB. Set alongside `#db`
   * and cleared whenever the DB is cleared.
   */
  #storage: ChainStorage | undefined

  /**
   * Note Commitment Merkle Tree
   */
  #noteCommitmentTree = new Map<number, NoteCommitmentTree>()

  /**
   * True when this engine constructed its own chain DB and is responsible
   * for closing it. False when a chain DB was injected via the constructor.
   */
  #ownsChainDB = true

  /**
   * Base directory under which chain DBs live (`<dataDir>/chains/<id>/chain.db`).
   * Ignored when `chainDB` is injected.
   */
  #dataDir: string

  /**
   * Construct an engine. Pass `chainDB` to inject a pre-configured database
   * (for tests). When omitted, the engine creates
   * `<dataDir>/chains/<id>/chain.db` the first time `scan()` runs (`dataDir`
   * defaults to `./.railgun`).
   * @param options - Optional `{ chainDB?, dataDir? }`.
   * @param options.chainDB - Pre-built ChainDB; engine will not close it.
   *   When provided, `dataDir` is ignored.
   * @param options.dataDir - Base directory for chain DB files. Defaults to
   *   `./.railgun`.
   */
  constructor (options: { chainDB?: ChainDB, dataDir?: string } = {}) {
    this.#dataDir = options.dataDir ?? './.railgun'
    if (options.chainDB) {
      this.#db = options.chainDB
      this.#storage = createChainStorage(options.chainDB)
      this.#ownsChainDB = false
    }
  }

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
   * Set current network for engine.
   *
   * Re-setting to the same network is a no-op. *Switching* to a different
   * network resets the chain DB and the in-memory merkle trees so the next
   * `scan()` opens its own DB at `<dataDir>/chains/<newChainID>/chain.db`
   * — without this reset, the next `scan()` would reuse the previous
   * network's DB and write the new chain's data into the wrong file. The
   * old chain DB is closed only when the engine owned it; an injected DB is
   * left untouched (the injector keeps responsibility for it) and the
   * caller is expected to provide a new one (or none) before the next
   * `scan()`. The initial `setNetwork()` (when no prior network was set)
   * does not reset, so an injected chain DB survives the first call.
   * @param networkName - Input Network Name
   */
  async setNetwork (networkName: NetworkName): Promise<void> {
    if (this.#currentNetwork === undefined) {
      this.#currentNetwork = networkName
      return
    }
    if (this.#currentNetwork === networkName) return
    if (this.#db && this.#ownsChainDB) {
      await closeChainDB(this.#db)
    }
    this.#db = undefined
    this.#storage = undefined
    this.#noteCommitmentTree.clear()
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
   * @param options - Optional `{ endBlock?, onBatch? }`.
   * @param options.endBlock - Inclusive ceiling; the scan exits after writing
   *   a block at or above this height.
   * @param options.onBatch - Fired after each batch is committed to chain.db
   *   with the resolved scan start and the highest block number in that
   *   batch. Synchronous; throwing aborts the run.
   * @param options.persistRailgunTransactions - Whether to persist PPOI
   *   Railgun transaction rows while denormalizing blocks.
   * @returns Last block number written to chain.db, or `undefined` when the
   *   source had nothing to yield.
   */
  async scan (options: {
    endBlock?: bigint | undefined
    onBatch?: ((startHeight: bigint, lastBlock: bigint) => void) | undefined
    persistRailgunTransactions?: boolean | undefined
  } = {}): Promise<bigint | undefined> {
    if (!this.#currentNetwork) {
      throw new Error('Scan failed: no network selected')
    }
    if (!this.#dataSource) {
      throw new Error('Scan failed: no data source set')
    }

    this.#networkConfig = NETWORK_CONFIG[this.#currentNetwork]
    this.#log(`EngineInit:: Initializing for Network ${this.#currentNetwork}`)

    if (!this.#db) {
      const dirName = path.join(this.#dataDir, 'chains', `${this.#networkConfig.chainID}`)
      if (!existsSync(dirName)) {
        mkdirSync(dirName, { recursive: true })
      }
      this.#db = await createChainDB({
        path: path.join(dirName, 'chain.db'),
        runMigrations: true
      })
      this.#storage = createChainStorage(this.#db)
    }

    await loadMerkleTrees(this.#storage!, this.#noteCommitmentTree)

    const lastSyncedBlock = (await this.#storage!.getSyncState(this.#networkConfig.chainID))?.lastBlockHeight
    const startHeight = lastSyncedBlock ? lastSyncedBlock + 1n : this.#networkConfig.deploymentBlock

    const onBatch = options.onBatch
    const wrappedOnBatch = onBatch
      ? (lastBlock: bigint) => onBatch(startHeight, lastBlock)
      : undefined
    return drainChainToTip({
      storage: this.#storage!,
      dataSource: this.#dataSource,
      trees: this.#noteCommitmentTree,
      chainID: this.#networkConfig.chainID,
      startHeight,
      endBlock: options.endBlock,
      onBatch: wrappedOnBatch,
      persistRailgunTransactions: options.persistRailgunTransactions !== false,
      log: this.#log
    })
  }

  /**
   * Get Chain DB Instance
   * @deprecated Use `storage` instead — all chain reads and writes go through
   * the `ChainStorage` contract. This raw handle remains only as a Node-side
   * escape hatch and will be removed once no consumer needs it.
   * @returns ChainDB Instance
   */
  get db () {
    return this.#db
  }

  /**
   * Get the ChainStorage contract bound to the current chain DB.
   * @returns ChainStorage instance, or `undefined` before a DB is opened.
   */
  get storage (): ChainStorage | undefined {
    return this.#storage
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
   * Release engine resources: close chain.db (only when owned) and tear
   * down the data source (when one was set).
   */
  async destroy (): Promise<void> {
    if (this.#db && this.#ownsChainDB) {
      await closeChainDB(this.#db)
    }
    if (this.#dataSource) {
      this.#dataSource.destroy()
    }
  }
}

export { RailgunEngine }
