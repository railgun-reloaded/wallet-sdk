import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'
import type { ChainDB, WalletDB } from '@railgun-reloaded/storage'
import {
  closeChainDB,
  closeWalletDB,
  createChainDB,
  createWalletDB,
  getSyncState
} from '@railgun-reloaded/storage'

import { RailgunEngine } from './engine'
import type {
  EventFilter,
  EventHandler,
  RailgunEventMap
} from './events'
import { EventBus } from './events'
import { NETWORK_CONFIG, NetworkName } from './network-config'
import type {
  DecryptedNote,
  TokenBalance
} from './services/balance/balance-service'
import { BalanceService } from './services/balance/balance-service'
import type {
  CreateWalletParams,
  WalletContext,
  WalletInfo
} from './services/wallet/wallet-service'
import { WalletService } from './services/wallet/wallet-service'
import type { DecryptSummary, SyncProgress } from './sync/wallet-decryptor'
import { SyncPhase, runWalletDecryption } from './sync/wallet-decryptor'
import {
  PoiNodeClient,
  PoiNodeUrlsRequiredError,
  PoiStatusService
} from './poi'
import type { RefreshSummary, WalletBalanceBucket } from './poi'

/**
 * Inputs for `RailgunClient.scan()`.
 */
type ScanParams = {
  network: NetworkName
  dataSource: SourceAggregator<EVMBlock>
  endBlock?: bigint
  /** Fired per batch with `phase: 'scan'`. Synchronous; throwing aborts the run. */
  onProgress?: (progress: SyncProgress) => void
}

/**
 * Inputs for `RailgunClient.decrypt()`.
 */
type DecryptParams = {
  /** Chain ID matching the data already in chain.db (e.g. 11155111 for Sepolia). */
  chainId: number
  /** Override the resumable cursor; defaults to `scanState.lastScannedBlock + 1`. */
  fromBlock?: bigint
  /** Stop point; defaults to chain.db's `syncState.lastBlockHeight`. */
  toBlock?: bigint
  /** Block-range chunk size for chain.db queries. Defaults to 10_000. */
  batchSize?: bigint
  /** Fired per batch with `phase: 'decrypt'`. Synchronous; throwing aborts the run. */
  onProgress?: (progress: SyncProgress) => void
}

/**
 * Inputs for `RailgunClient.sync()`. Combines `ScanParams` with the wallet
 * decryption knobs from `DecryptParams` minus `chainId` (derived from
 * `network`).
 */
type SyncParams = {
  network: NetworkName
  dataSource: SourceAggregator<EVMBlock>
  /** Inclusive ceiling on chain ingestion. */
  endBlock?: bigint
  /** Override the wallet decryption cursor; defaults to scanState + 1. */
  fromBlock?: bigint
  /** Stop point for decryption; defaults to chain.db's tip. */
  toBlock?: bigint
  /** Decryption block-range chunk size. Defaults to 10_000. */
  batchSize?: bigint
  /** Refresh PPOI status after decryption on PPOI networks. Defaults to true. */
  refreshPoi?: boolean
  /** Fired per batch from all sync phases. `phase` distinguishes the source. */
  onProgress?: (progress: SyncProgress) => void
}

/**
 * Combined result of a `sync()` call: the engine scan outcome plus the
 * wallet decryption summary.
 */
type SyncSummary = {
  scan: { lastBlock: bigint | undefined }
  decrypt: DecryptSummary
  poi?: RefreshSummary
}

/**
 * Options for constructing a RailgunClient.
 */
type RailgunClientOptions = {
  /**
   * Base directory for data files. Defaults to './.railgun'.
   * Chain DBs live under `<dataDir>/chains/<chainID>/`, wallet DB at
   * `<dataDir>/wallets.db`.
   */
  dataDir?: string

  /**
   * Pre-constructed wallet DB. When provided, `dataDir` is ignored for the
   * wallet DB (the engine's chain DB still uses `dataDir`). Primarily for
   * tests — pass a `createWalletDB({ path: ':memory:', runMigrations: true })`.
   */
  walletDB?: WalletDB

  /**
   * Pre-constructed chain DB. When provided, `scan()` ingests into this DB
   * instead of opening one under `dataDir`. Primarily for tests — pass a
   * `createChainDB({ path: ':memory:', runMigrations: true })`.
   */
  chainDB?: ChainDB

  /**
   * PPOI node URLs by network. Presence is validated only when a
   * PPOI-aware operation runs on a network that requires PPOI.
   */
  poiNodeUrls?: Partial<Record<NetworkName, string[]>>
}

const DEFAULT_DATA_DIR = './.railgun'
const EMPTY_REFRESH_SUMMARY: RefreshSummary = {
  checked: 0,
  updated: 0,
  skipped: 0,
  failed: 0
}

const requireFromHere = createRequire(__filename)

/**
 * Resolve the absolute path to the storage package's wallet migrations,
 * regardless of whether the storage package is installed as a symlink
 * (workspace) or as a published tarball.
 * @returns Absolute path to `<storagePkg>/drizzle/wallet`.
 */
function resolveWalletMigrationsFolder (): string {
  const storageEntry = requireFromHere.resolve('@railgun-reloaded/storage')
  // storageEntry is .../<storage pkg>/src/index.js — walk up two levels to
  // reach the package root, then into drizzle/wallet.
  const packageRoot = path.dirname(path.dirname(storageEntry))
  return path.join(packageRoot, 'drizzle', 'wallet')
}

/**
 * Build the engine `onBatch` callback that translates a per-batch
 * `(startHeight, lastBlock)` notification into a scan-phase `SyncProgress`
 * event. `startHeight` is the engine's resolved scan start (persisted
 * `syncState.lastBlockHeight + 1` or the network's deployment block), so
 * `blocksScanned` reflects the true window — not just blocks since the
 * first notification.
 * @param onProgress - Progress callback supplied to `scan()`.
 * @param endBlock - Optional inclusive ceiling set by the caller.
 * @returns Function compatible with `RailgunEngine.scan({ onBatch })`.
 */
function makeScanOnBatch (
  onProgress: NonNullable<ScanParams['onProgress']>,
  endBlock?: bigint
): (startHeight: bigint, lastBlock: bigint) => void {
  return (startHeight: bigint, lastBlock: bigint) => {
    onProgress({
      phase: SyncPhase.Scan,
      fromBlock: startHeight,
      toBlock: endBlock ?? lastBlock,
      currentBlock: lastBlock,
      blocksScanned: lastBlock - startHeight + 1n,
      notesAdded: 0,
      notesSpent: 0
    })
  }
}

function clonePoiNodeUrls (
  poiNodeUrls: RailgunClientOptions['poiNodeUrls'] = {}
): Partial<Record<NetworkName, string[]>> {
  const cloned: Partial<Record<NetworkName, string[]>> = {}
  for (const network of Object.values(NetworkName) as NetworkName[]) {
    const urls = poiNodeUrls[network]
    if (urls !== undefined) {
      cloned[network] = [...urls]
    }
  }
  return cloned
}

function hasUsablePoiNodeUrls (urls: string[] | undefined): boolean {
  return urls?.some(url => url.trim().length > 0) ?? false
}

function findNetworkByChainId (chainId: number): NetworkName | undefined {
  return (Object.values(NetworkName) as NetworkName[])
    .find(network => NETWORK_CONFIG[network].chainID === chainId)
}

/**
 * Top-level entry point for @railgun-reloaded/wallet-sdk.
 *
 * Composes WalletService (persistent, encrypted wallet lifecycle) with
 * RailgunEngine (chain sync). Thin orchestrator — no business logic.
 */
class RailgunClient {
  /** In-process event bus owned by this client. Cleared on close(). */
  readonly #bus = new EventBus()

  /** True once close() has torn down this client's event surface. */
  #closed = false

  /** Underlying wallet-service instance. */
  readonly #walletService: WalletService

  /** Read API over cached wallet balances and notes. */
  readonly #balanceService: BalanceService

  /** The wallet DB in use (either injected or auto-created). */
  readonly #walletDB: WalletDB

  /** Base directory used for owned chain DBs. */
  readonly #dataDir: string

  /** True when this client constructed its own DB and is responsible for closing it. */
  readonly #ownsWalletDB: boolean

  /** RailgunEngine instance exposed via the `engine` getter. */
  readonly #engine: RailgunEngine

  /** PPOI node URLs passed at construction, validated lazily per network. */
  readonly #poiNodeUrls: Partial<Record<NetworkName, string[]>>

  /**
   * Construct a RailgunClient.
   * @param options - Optional `{ dataDir?, walletDB?, chainDB? }`. Injected
   *   DBs are not owned by the client and won't be closed by `close()`.
   *   When omitted, DBs are created under `dataDir` (default: `./.railgun`).
   */
  constructor (options: RailgunClientOptions = {}) {
    const dataDir = options.dataDir ?? DEFAULT_DATA_DIR
    this.#dataDir = dataDir

    if (options.walletDB) {
      this.#walletDB = options.walletDB
      this.#ownsWalletDB = false
    } else {
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true })
      }
      this.#walletDB = createWalletDB({
        path: path.join(dataDir, 'wallets.db'),
        runMigrations: true,
        migrationsFolder: resolveWalletMigrationsFolder()
      })
      this.#ownsWalletDB = true
    }

    this.#walletService = new WalletService(this.#walletDB)
    this.#balanceService = new BalanceService(this.#walletDB)
    this.#poiNodeUrls = clonePoiNodeUrls(options.poiNodeUrls)
    this.#engine = new RailgunEngine(
      options.chainDB ? { chainDB: options.chainDB } : { dataDir }
    )
  }

  /**
   * Create and persist an encrypted wallet. Delegates to WalletService.
   * @param params - Mnemonic + encryption key + optional index/name.
   * @returns Decrypt-free WalletInfo.
   */
  createWallet (params: CreateWalletParams): Promise<WalletInfo> {
    return this.#walletService.createWallet(params)
  }

  /**
   * Load a wallet by ID. Delegates to WalletService.
   * @param walletId - Wallet to load.
   * @param encryptionKey - 32-byte key used at creation time.
   * @returns Full WalletContext (minus spending key).
   */
  loadWallet (walletId: string, encryptionKey: Uint8Array): Promise<WalletContext> {
    return this.#walletService.loadWallet(walletId, encryptionKey)
  }

  /**
   * List all stored wallets (decrypt-free). Delegates to WalletService.
   * @returns Array of WalletInfo sorted by createdAt ASC.
   */
  listWallets (): Promise<WalletInfo[]> {
    return this.#walletService.listWallets()
  }

  /**
   * Delete a wallet by ID. Idempotent. Delegates to WalletService.
   * @param walletId - Wallet to remove.
   * @returns Resolves when the delete completes.
   */
  deleteWallet (walletId: string): Promise<void> {
    return this.#walletService.deleteWallet(walletId)
  }

  /**
   * Read all cached ERC-20 balances for a wallet on a given chain.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param chainId - Chain id to scope the lookup to (e.g. 11155111 for Sepolia).
   * @returns Token balances from wallet.db.balances.
   */
  getBalances (walletId: string, chainId: number): Promise<TokenBalance[]> {
    return this.#balanceService.getBalances(walletId, chainId)
  }

  /**
   * Read spendable ERC-20 balances for a wallet on a given chain.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param chainId - Chain id to scope the lookup to.
   * @returns Token balances classified into `WalletBalanceBucket.Spendable`.
   */
  getSpendableBalances (
    walletId: string,
    chainId: number
  ): Promise<TokenBalance[]> {
    return this.#balanceService.getSpendableBalances(walletId, chainId)
  }

  /**
   * Read unspent ERC-20 balances grouped by POI balance bucket.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param chainId - Chain id to scope the lookup to.
   * @returns Token balances keyed by `WalletBalanceBucket`.
   */
  getBalancesByBucket (
    walletId: string,
    chainId: number
  ): Promise<Record<WalletBalanceBucket, TokenBalance[]>> {
    return this.#balanceService.getBalancesByBucket(walletId, chainId)
  }

  /**
   * Read one cached ERC-20 token balance for a wallet on a given chain.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param chainId - Chain id to scope the lookup to.
   * @param tokenAddress - ERC-20 token address. Lookup is case-insensitive.
   * @returns Balance amount, or 0n when no cached balance exists.
   */
  getTokenBalance (
    walletId: string,
    chainId: number,
    tokenAddress: string
  ): Promise<bigint> {
    return this.#balanceService.getTokenBalance(walletId, chainId, tokenAddress)
  }

  /**
   * Read decrypted notes for a wallet on a given chain.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param chainId - Chain id to scope the lookup to.
   * @param options - Optional note filtering.
   * @param options.unspent - When true, only return unspent notes.
   * @returns Decrypted notes from wallet.db.notes.
   */
  getNotes (
    walletId: string,
    chainId: number,
    options?: { unspent?: boolean }
  ): Promise<DecryptedNote[]> {
    return this.#balanceService.getNotes(walletId, chainId, options)
  }

  /**
   * Subscribe to a Railgun event.
   * @param event - Event name from RailgunEventMap.
   * @param handler - Synchronous handler. Throws are caught and re-emitted
   *   as 'error'; the originating method is unaffected.
   * @param filter - Optional `{ walletId?, chainId? }`. Handler fires only
   *   when every provided field matches the event payload.
   * @returns Idempotent unsubscribe function.
   */
  on<E extends keyof RailgunEventMap> (
    event: E,
    handler: EventHandler<E>,
    filter?: EventFilter
  ): () => void {
    if (this.#closed) {
      return () => {}
    }
    return this.#bus.on(event, handler, filter)
  }

  /**
   * Remove every subscriber, or every subscriber for one event.
   * Called automatically by close().
   * @param event - Optional event name to scope the clear.
   */
  removeAllListeners (event?: keyof RailgunEventMap): void {
    this.#bus.removeAllListeners(event)
  }

  /**
   * The underlying RailgunEngine for chain sync operations.
   * @returns The engine instance.
   */
  get engine (): RailgunEngine {
    return this.#engine
  }

  /**
   * Refresh persisted PPOI status for received notes without running scan or
   * decrypt first.
   * @param walletId - Wallet ID returned from `createWallet` / `listWallets`.
   * @param chainId - Chain id to scope the refresh to.
   * @returns Refresh counters for notes checked, updated, skipped, and failed.
   */
  refreshPoiStatus (
    walletId: string,
    chainId: number
  ): Promise<RefreshSummary> {
    const network = findNetworkByChainId(chainId)
    if (network === undefined || NETWORK_CONFIG[network].poi === undefined) {
      return Promise.resolve({ ...EMPTY_REFRESH_SUMMARY })
    }
    return this.#refreshPoiStatusForNetwork(walletId, chainId, network)
  }

  /**
   * Drain the supplied data source into chain.db for `network`. Returns when
   * the source reaches its current tip (or `endBlock`, when set). Live
   * sources never reach a natural tip — bound them with `endBlock`.
   *
   * Calling this method twice with different networks reconfigures the engine
   * each time. The wallet DB is untouched; use `decrypt()` to populate
   * per-wallet state from the synced chain DB.
   * @param params - Sync target plus optional bounds.
   * @param params.network - Network name (e.g. `NetworkName.EthereumSepolia`).
   * @param params.dataSource - Aggregator that yields EVM blocks.
   * @param params.endBlock - Inclusive ceiling on blocks to ingest.
   * @returns Last block number written to chain.db, or `undefined` when the
   *   source had nothing to yield.
   */
  async scan (params: ScanParams): Promise<bigint | undefined> {
    this.#engine.setDataSource(params.dataSource)
    this.#engine.setNetwork(params.network)
    const chainId = NETWORK_CONFIG[params.network].chainID
    const previousLastBlock = this.#getPreviousChainLastBlock(chainId)
    const scanStartBlock = previousLastBlock !== undefined
      ? previousLastBlock + 1n
      : NETWORK_CONFIG[params.network].deploymentBlock
    const startTime = Date.now()
    let blocksScanned = 0n
    this.#bus.emit('sync:start', {
      chainId,
      phase: 'scan',
      fromBlock: scanStartBlock,
      ...(params.endBlock !== undefined && { toBlock: params.endBlock }),
      timestamp: new Date()
    })

    const userOnProgress = params.onProgress
    /**
     * Forward scan progress to the caller's callback and the client event bus.
     * @param progress - Scan progress emitted from the engine batch adapter.
     */
    const wrappedOnProgress = (progress: SyncProgress) => {
      userOnProgress?.(progress)
      blocksScanned = progress.blocksScanned
      this.#bus.emit('sync:progress', {
        chainId,
        phase: 'scan',
        fromBlock: progress.fromBlock,
        toBlock: progress.toBlock,
        currentBlock: progress.currentBlock,
        blocksScanned: progress.blocksScanned,
        notesAdded: 0,
        notesSpent: 0,
        timestamp: new Date()
      })
    }

    try {
      const lastBlock = await this.#engine.scan({
        ...(params.endBlock !== undefined && { endBlock: params.endBlock }),
        onBatch: makeScanOnBatch(wrappedOnProgress, params.endBlock)
      })
      const completeBlocksScanned = blocksScanned > 0n
        ? blocksScanned
        : countCoveredBlocks(scanStartBlock, lastBlock)
      this.#bus.emit('sync:complete', {
        chainId,
        phase: 'scan',
        blocksScanned: completeBlocksScanned,
        notesAdded: 0,
        notesSpent: 0,
        durationMs: Date.now() - startTime,
        timestamp: new Date()
      })
      return lastBlock
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.#bus.emit('sync:error', {
        chainId,
        phase: 'scan',
        error,
        timestamp: new Date()
      })
      throw err
    }
  }

  /**
   * Decrypt the wallet's notes from chain.db into wallet.db. Pure consumer
   * of chain state — call `scan()` first to populate chain.db. Idempotent:
   * the persisted scan cursor (`scanState.lastScannedBlock`) makes repeated
   * calls a no-op once the wallet is up to date.
   *
   * Throws when `scan()` has not yet opened a chain DB for the given chain.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param encryptionKey - Same 32-byte key used at wallet creation time.
   * @param params - Decryption target plus optional bounds.
   * @returns Summary of blocks scanned and notes added/spent.
   */
  async decrypt (
    walletId: string,
    encryptionKey: Uint8Array,
    params: DecryptParams
  ): Promise<DecryptSummary> {
    const chainDb = this.#engine.db
    if (!chainDb) {
      throw new Error('Decrypt failed: chain DB not initialized — call scan() first')
    }
    const walletContext = await this.#walletService.loadWallet(walletId, encryptionKey)
    const chainId = params.chainId
    const startTime = Date.now()
    this.#bus.emit('sync:start', {
      walletId,
      chainId,
      phase: 'decrypt',
      ...(params.fromBlock !== undefined && { fromBlock: params.fromBlock }),
      ...(params.toBlock !== undefined && { toBlock: params.toBlock }),
      timestamp: new Date()
    })

    try {
      const userOnProgress = params.onProgress
      const summary = await runWalletDecryption({
        chainDb,
        walletDb: this.#walletDB,
        walletContext,
        chainId,
        ...(params.fromBlock !== undefined && { fromBlock: params.fromBlock }),
        ...(params.toBlock !== undefined && { toBlock: params.toBlock }),
        ...(params.batchSize !== undefined && { batchSize: params.batchSize }),
        /**
         * Forward decrypt progress to the caller's callback and event bus.
         * @param progress - Decryptor progress payload.
         */
        onProgress: (progress) => {
          userOnProgress?.(progress)
          this.#bus.emit('sync:progress', {
            walletId,
            chainId,
            phase: 'decrypt',
            fromBlock: progress.fromBlock,
            toBlock: progress.toBlock,
            currentBlock: progress.currentBlock,
            blocksScanned: progress.blocksScanned,
            notesAdded: progress.notesAdded,
            notesSpent: progress.notesSpent,
            timestamp: new Date()
          })
        }
      })

      if (summary.notesAdded > 0 || summary.notesSpent > 0) {
        const balances = await this.#balanceService.getBalances(walletId)
        this.#bus.emit('balance:update', {
          walletId,
          chainId,
          balances,
          notesAdded: summary.notesAdded,
          notesSpent: summary.notesSpent,
          timestamp: new Date()
        })
      }

      this.#bus.emit('sync:complete', {
        walletId,
        chainId,
        phase: 'decrypt',
        blocksScanned: summary.blocksScanned,
        notesAdded: summary.notesAdded,
        notesSpent: summary.notesSpent,
        durationMs: Date.now() - startTime,
        timestamp: new Date()
      })

      return summary
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.#bus.emit('sync:error', {
        walletId,
        chainId,
        phase: 'decrypt',
        error,
        timestamp: new Date()
      })
      throw err
    }
  }

  /**
   * Convenience composer: drain chain state into chain.db (`scan`) then
   * decrypt the wallet's notes from chain.db into wallet.db (`decrypt`).
   * Equivalent to calling `scan()` and `decrypt()` back-to-back; consumers
   * who want scan-only or decrypt-only should call those primitives instead.
   * @param walletId - Wallet ID to decrypt for.
   * @param encryptionKey - 32-byte key used at wallet creation time.
   * @param params - Network + data source + optional bounds.
   * @returns Combined summary: last scanned block + decryption counters.
   */
  async sync (
    walletId: string,
    encryptionKey: Uint8Array,
    params: SyncParams
  ): Promise<SyncSummary> {
    const chainId = NETWORK_CONFIG[params.network].chainID
    const startTime = Date.now()
    const outerToBlock = params.toBlock ?? params.endBlock
    this.#bus.emit('sync:start', {
      walletId,
      chainId,
      phase: 'sync',
      ...(params.fromBlock !== undefined && { fromBlock: params.fromBlock }),
      ...(outerToBlock !== undefined && { toBlock: outerToBlock }),
      timestamp: new Date()
    })

    try {
      const lastBlock = await this.scan({
        network: params.network,
        dataSource: params.dataSource,
        ...(params.endBlock !== undefined && { endBlock: params.endBlock }),
        ...(params.onProgress !== undefined && { onProgress: params.onProgress })
      })
      const decrypt = await this.decrypt(walletId, encryptionKey, {
        chainId,
        ...(params.fromBlock !== undefined && { fromBlock: params.fromBlock }),
        ...(params.toBlock !== undefined && { toBlock: params.toBlock }),
        ...(params.batchSize !== undefined && { batchSize: params.batchSize }),
        ...(params.onProgress !== undefined && { onProgress: params.onProgress })
      })

      const poi = NETWORK_CONFIG[params.network].poi !== undefined &&
        params.refreshPoi !== false
        ? await this.#refreshPoiStatusForNetwork(
          walletId,
          chainId,
          params.network,
          params.onProgress
        )
        : undefined

      this.#bus.emit('sync:complete', {
        walletId,
        chainId,
        phase: 'sync',
        blocksScanned: decrypt.blocksScanned,
        notesAdded: decrypt.notesAdded,
        notesSpent: decrypt.notesSpent,
        durationMs: Date.now() - startTime,
        timestamp: new Date()
      })
      return {
        scan: { lastBlock },
        decrypt,
        ...(poi !== undefined && { poi })
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.#bus.emit('sync:error', {
        walletId,
        chainId,
        phase: 'sync',
        error,
        timestamp: new Date()
      })
      throw err
    }
  }

  #refreshPoiStatusForNetwork (
    walletId: string,
    chainId: number,
    network: NetworkName,
    onProgress?: (progress: SyncProgress) => void
  ): Promise<RefreshSummary> {
    this.#assertPoiNodeUrls(network)
    const service = new PoiStatusService({
      walletDb: this.#walletDB,
      network,
      poiNodeClient: new PoiNodeClient({ poiNodeUrls: this.#poiNodeUrls })
    })
    return service.refresh(walletId, chainId, {
      ...(onProgress !== undefined && { onProgress })
    })
  }

  #assertPoiNodeUrls (network: NetworkName): void {
    if (
      NETWORK_CONFIG[network].poi !== undefined &&
      !hasUsablePoiNodeUrls(this.#poiNodeUrls[network])
    ) {
      throw new PoiNodeUrlsRequiredError(network)
    }
  }

  /**
   * Release resources owned by this client: tears down the engine (which
   * closes its chain DB only when it owns it, and destroys the configured
   * data source when one was set) and closes the wallet DB only when it
   * was created internally. Injected DBs remain the caller's responsibility.
   */
  close (): void {
    this.#bus.removeAllListeners()
    this.#closed = true
    this.#engine.destroy()
    if (this.#ownsWalletDB) {
      closeWalletDB(this.#walletDB)
    }
  }

  /**
   * Read the persisted chain cursor before scan opens or advances the DB.
   * @param chainId - Chain ID for the configured network.
   * @returns Previous persisted last scanned block, if any.
   */
  #getPreviousChainLastBlock (chainId: number): bigint | undefined {
    if (this.#engine.db) {
      return getSyncState(this.#engine.db, chainId)?.lastBlockHeight
    }

    const chainDbPath = path.join(this.#dataDir, 'chains', `${chainId}`, 'chain.db')
    if (!existsSync(chainDbPath)) {
      return undefined
    }

    const chainDB = createChainDB({ path: chainDbPath })
    try {
      return getSyncState(chainDB, chainId)?.lastBlockHeight
    } finally {
      closeChainDB(chainDB)
    }
  }
}

/**
 * Count covered blocks for a scan that returned a high-water mark without
 * emitting any per-batch progress, such as an empty event range.
 * @param fromBlock - Inclusive scan start.
 * @param toBlock - Inclusive covered high-water mark, if any.
 * @returns Covered block count, or 0 when no new range was covered.
 */
function countCoveredBlocks (
  fromBlock: bigint,
  toBlock: bigint | undefined
): bigint {
  if (toBlock === undefined || toBlock < fromBlock) {
    return 0n
  }
  return toBlock - fromBlock + 1n
}

export { RailgunClient, SyncPhase }
export type {
  DecryptedNote,
  DecryptParams,
  RailgunClientOptions,
  ScanParams,
  SyncParams,
  SyncProgress,
  SyncSummary,
  RefreshSummary,
  TokenBalance
}
