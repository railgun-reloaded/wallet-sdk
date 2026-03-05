import path from 'path'

import type { ChainDB } from '@reloaded/storage/chain'
import { createChainDB, getSyncState, insertNullifiersBatch, updateSyncState } from '@reloaded/storage/chain'
import type { EVMBlock, SourceAggregator } from 'scanner'

import { createChainDBTables } from './db-utils'
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
          runMigrations: false
        })

        // This should be created by some command in package.json
        createChainDBTables(this.#db)
      }

      const lastSycedBlock = getSyncState(this.#db, this.#networkConfig.chainID)?.lastBlock
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

    // Batch size, when reached should update the DB
    // This is to reduce the DB load by updating entries in batch
    const batchInsertSize = 100
    let nullifierBatch = []
    let totalBlocks = 0
    let lastBlockNumber = 0n
    for await (const block of eventIterator) {
      const { nullifiers } = denormalizeBlockData(block)
      nullifierBatch.push(...nullifiers)
      totalBlocks += 1

      if (totalBlocks > batchInsertSize) {
        // We insert in batch to reduce the cost of updating database
        const intsertedNullifiers = insertNullifiersBatch(this.#db!, nullifierBatch)
        updateSyncState(this.#db!, this.#networkConfig.chainID, block.number)
        this.#log(`Inserting batch, blockNumber:${block.number}, Nullifiers: ${intsertedNullifiers}`)
        nullifierBatch = []
        totalBlocks = 0
      }
      lastBlockNumber = block.number
    }
    if (totalBlocks > 0) {
      // We insert in batch to reduce the cost of updating database
      const insertedNullifiers = insertNullifiersBatch(this.#db!, nullifierBatch)
      updateSyncState(this.#db!, this.#networkConfig.chainID, lastBlockNumber)
      this.#log(`Inserting batch, blockNumber:${lastBlockNumber}, Nullifiers: ${insertedNullifiers}`)
    }
  }

  /**
   * Destroy Railgun Engine
   */
  destroy () {
    this.#dataSource.destroy()
  }
}

export { RailgunEngine }
