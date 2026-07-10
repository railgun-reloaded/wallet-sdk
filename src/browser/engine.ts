import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'
import type { ChainStorage } from '@railgun-reloaded/storage'

import type { NoteCommitmentTree } from '../merkle/index.js'
import type { NetworkConfig, NetworkName } from '../network-config.js'
import { NETWORK_CONFIG } from '../network-config.js'
import { drainChainToTip, loadMerkleTrees } from '../sync/chain-sync.js'

/**
 * Portable RailgunEngine for browser (and any non-Node) runtimes.
 *
 * Mirrors the Node engine's scan surface but never touches a filesystem or
 * opens databases: the caller constructs a `ChainStorage` (for example from
 * `@railgun-reloaded/storage/browser`) and injects it. The caller owns the
 * storage lifecycle — `destroy()` tears down the data source only.
 */
class RailgunEngine {
  /** Aggregated data source used for chain synchronization. */
  #dataSource!: SourceAggregator<EVMBlock>

  /** Optional Logger Function */
  #log: (message: string) => void = console.log

  /** Currently selected network. `undefined` until `setNetwork()` is called. */
  #currentNetwork: NetworkName | undefined

  /** NetworkConfig for currently selected network */
  #networkConfig!: NetworkConfig

  /** Injected chain storage contract all chain data is written through. */
  readonly #storage: ChainStorage

  /** Note Commitment Merkle Tree */
  #noteCommitmentTree = new Map<number, NoteCommitmentTree>()

  /**
   * Construct a portable engine around an injected chain storage.
   * @param options - Required `{ chainStorage }`.
   * @param options.chainStorage - Chain storage contract; caller owns its
   *   lifecycle (open/close/delete).
   */
  constructor (options: { chainStorage: ChainStorage }) {
    this.#storage = options.chainStorage
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
   * Set current network for engine. Re-setting to the same network is a
   * no-op. Unlike the Node engine, switching networks is rejected: the
   * injected chain storage holds one network's data, so a different network
   * needs a fresh storage and a fresh engine.
   * @param networkName - Input Network Name
   */
  async setNetwork (networkName: NetworkName): Promise<void> {
    if (this.#currentNetwork === undefined || this.#currentNetwork === networkName) {
      this.#currentNetwork = networkName
      return
    }
    throw new Error(
      `Network switch from ${this.#currentNetwork} to ${networkName} is not supported: construct a new engine with a chain storage for the target network`
    )
  }

  /**
   * Set Logger for Railgun Engine
   * @param log - Logger Function
   */
  setLogger (log: (msg: string) => void) {
    this.#log = log
  }

  /**
   * Drain the configured data source into the chain storage, returning when
   * the source reaches its current tip. Resumes from the persisted sync
   * cursor when one exists, otherwise starts at the network's deployment
   * block. Live sources never reach a natural tip; bound the scan with
   * `endBlock` when using one.
   * @param options - Optional `{ endBlock?, onBatch?, persistRailgunTransactions? }`.
   * @param options.endBlock - Inclusive ceiling; the scan exits after writing
   *   a block at or above this height.
   * @param options.onBatch - Fired after each batch is committed with the
   *   resolved scan start and the highest block number in that batch.
   *   Synchronous; throwing aborts the run.
   * @param options.persistRailgunTransactions - Whether to persist PPOI
   *   Railgun transaction rows while denormalizing blocks.
   * @returns Last block number written, or `undefined` when the source had
   *   nothing to yield.
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

    await loadMerkleTrees(this.#storage, this.#noteCommitmentTree)

    const lastSyncedBlock = (await this.#storage.getSyncState(this.#networkConfig.chainID))?.lastBlockHeight
    const startHeight = lastSyncedBlock ? lastSyncedBlock + 1n : this.#networkConfig.deploymentBlock

    const onBatch = options.onBatch
    const wrappedOnBatch = onBatch
      ? (lastBlock: bigint) => onBatch(startHeight, lastBlock)
      : undefined
    return drainChainToTip({
      storage: this.#storage,
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
   * Get the injected ChainStorage contract.
   * @returns ChainStorage instance.
   */
  get storage (): ChainStorage {
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
   * Release engine resources: tear down the data source when one was set.
   * The injected chain storage is caller-owned and left untouched.
   */
  async destroy (): Promise<void> {
    if (this.#dataSource) {
      this.#dataSource.destroy()
    }
  }
}

export { RailgunEngine }
