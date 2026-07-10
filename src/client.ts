import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'
import type { WalletStorage } from '@railgun-reloaded/storage'
import type { ChainDB, WalletDB } from '@railgun-reloaded/storage/node'
import {
  closeChainDB,
  closeWalletDB,
  createChainDB,
  createChainStorage,
  createWalletDB,
  createWalletStorage
} from '@railgun-reloaded/storage/node'

import {
  clonePoiNodeUrls,
  findNetworkByChainId,
  hasUsablePoiNodeUrls,
  makeScanOnBatch
} from './client-helpers.js'
import { RailgunEngine } from './engine.js'
import type {
  EventFilter,
  EventHandler,
  RailgunEventMap,
  SyncProgressEvent
} from './events/index.js'
import { EventBus } from './events/index.js'
import { initializeCrypto } from './init/crypto.js'
import type { NetworkName } from './network-config.js'
import { NETWORK_CONFIG } from './network-config.js'
import type { RefreshSummary, WalletBalanceBucket } from './poi/index.js'
import {
  PoiNodeClient,
  PoiNodeUrlsRequiredError,
  PoiStatusService
} from './poi/index.js'
import type {
  BalanceMode,
  DecryptedNote,
  TokenBalance
} from './services/balance/balance-service.js'
import { BalanceService } from './services/balance/balance-service.js'
import type {
  CreateWalletParams,
  WalletContext,
  WalletInfo
} from './services/wallet/wallet-service.js'
import { WalletService } from './services/wallet/wallet-service.js'
import type { DecryptSummary, SyncProgress } from './sync/wallet-decryptor.js'
import { SyncPhase, runWalletDecryption } from './sync/wallet-decryptor.js'

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

const requireFromHere = createRequire(import.meta.url)

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

  /** Read API over live wallet notes. */
  readonly #balanceService: BalanceService

  /** The wallet DB in use (either injected or auto-created). */
  readonly #walletDB: WalletDB

  /** WalletStorage contract bound to `#walletDB`. */
  readonly #walletStorage: WalletStorage

  /** Base directory used for owned chain DBs. */
  readonly #dataDir: string

  /** True when this client constructed its own DB and is responsible for closing it. */
  readonly #ownsWalletDB: boolean

  /** RailgunEngine instance exposed via the `engine` getter. */
  readonly #engine: RailgunEngine

  /** PPOI node URLs passed at construction, validated lazily per network. */
  readonly #poiNodeUrls: Partial<Record<NetworkName, string[]>>

  /**
   * Wire up services around an already-opened wallet DB. Private because
   * opening a wallet DB is asynchronous — use the static `create()` factory.
   * @param walletDB - Opened wallet DB instance.
   * @param ownsWalletDB - True when the client opened the DB itself and is
   *   responsible for closing it.
   * @param options - Construction options.
   */
  private constructor (
    walletDB: WalletDB,
    ownsWalletDB: boolean,
    options: RailgunClientOptions
  ) {
    this.#dataDir = options.dataDir ?? DEFAULT_DATA_DIR
    this.#walletDB = walletDB
    this.#walletStorage = createWalletStorage(walletDB)
    this.#ownsWalletDB = ownsWalletDB

    this.#walletService = new WalletService(this.#walletStorage)
    this.#balanceService = new BalanceService(this.#walletStorage)
    this.#poiNodeUrls = clonePoiNodeUrls(options.poiNodeUrls)
    this.#engine = new RailgunEngine(
      options.chainDB ? { chainDB: options.chainDB } : { dataDir: this.#dataDir }
    )
  }

  /**
   * Create a RailgunClient.
   * @param options - Optional `{ dataDir?, walletDB?, chainDB? }`. Injected
   *   DBs are not owned by the client and won't be closed by `close()`.
   *   When omitted, DBs are created under `dataDir` (default: `./.railgun`).
   * @returns Ready-to-use client with its wallet DB opened and migrated.
   */
  static async create (options: RailgunClientOptions = {}): Promise<RailgunClient> {
    if (options.walletDB) {
      return new RailgunClient(options.walletDB, false, options)
    }

    const dataDir = options.dataDir ?? DEFAULT_DATA_DIR
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true })
    }
    const walletDB = await createWalletDB({
      path: path.join(dataDir, 'wallets.db'),
      runMigrations: true,
      migrationsFolder: resolveWalletMigrationsFolder()
    })
    return new RailgunClient(walletDB, true, options)
  }

  /**
   * Eagerly initialize the cryptography libraries this client depends on.
   * Wallet operations otherwise initialize lazily via `deriveWalletKeys` on
   * first use; call this at startup to pay the cost up front. Idempotent
   * across calls and across `RailgunClient` instances in the same process.
   * @returns A promise that resolves once the cryptography libraries are ready.
   */
  initialize (): Promise<void> {
    return initializeCrypto()
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
   * Read ERC-20 balances for a wallet on a given chain from live unspent notes.
   * Bucket filtering uses the flat `WalletBalanceBucket` adapter over the
   * note's two-tier spend state.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param chainId - Chain id to scope the lookup to (e.g. 11155111 for Sepolia).
   * @param mode - Balance mode: default spendable, all unspent, or one bucket.
   * @returns Token balances grouped by token.
   */
  getBalances (
    walletId: string,
    chainId: number,
    mode?: BalanceMode
  ): Promise<TokenBalance[]> {
    return this.#balanceService.getBalances(walletId, chainId, mode)
  }

  /**
   * Read unspent ERC-20 balances grouped by legacy flat balance bucket.
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
   * Read decrypted notes with protocol and optional POI spend state.
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
  async refreshPoiStatus (
    walletId: string,
    chainId: number
  ): Promise<RefreshSummary> {
    const network = findNetworkByChainId(chainId)
    if (network === undefined || NETWORK_CONFIG[network].poi === undefined) {
      return { ...EMPTY_REFRESH_SUMMARY }
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
    await this.#engine.setNetwork(params.network)
    const chainId = NETWORK_CONFIG[params.network].chainID
    const previousLastBlock = await this.#getPreviousChainLastBlock(chainId)
    const scanStartBlock = previousLastBlock !== undefined
      ? previousLastBlock + 1n
      : NETWORK_CONFIG[params.network].deploymentBlock
    const startedAt = Date.now()
    let blocksScanned = 0n

    this.#emit('sync:start', {
      chainId,
      phase: 'scan',
      fromBlock: scanStartBlock,
      ...(params.endBlock !== undefined && { toBlock: params.endBlock }),
      timestamp: new Date()
    })

    const onBatch = makeScanOnBatch((progress) => {
      params.onProgress?.(progress)
      blocksScanned = progress.blocksScanned
      this.#emitProgress(progress, chainId)
    }, params.endBlock)

    try {
      const lastBlock = await this.#engine.scan({
        ...(params.endBlock !== undefined && { endBlock: params.endBlock }),
        onBatch
      })
      const completeBlocksScanned = blocksScanned > 0n
        ? blocksScanned
        : countCoveredBlocks(scanStartBlock, lastBlock)
      this.#emit('sync:complete', {
        chainId,
        phase: 'scan',
        blocksScanned: completeBlocksScanned,
        notesAdded: 0,
        notesSpent: 0,
        durationMs: Date.now() - startedAt,
        timestamp: new Date()
      })
      return lastBlock
    } catch (err) {
      this.#emit('sync:error', {
        chainId,
        phase: 'scan',
        error: toError(err),
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
    const chainStorage = this.#engine.storage
    if (!chainStorage) {
      throw new Error('Decrypt failed: chain DB not initialized — call scan() first')
    }
    const walletContext = await this.#walletService.loadWallet(walletId, encryptionKey)
    const chainId = params.chainId
    const startedAt = Date.now()

    this.#emit('sync:start', {
      walletId,
      chainId,
      phase: 'decrypt',
      ...(params.fromBlock !== undefined && { fromBlock: params.fromBlock }),
      ...(params.toBlock !== undefined && { toBlock: params.toBlock }),
      timestamp: new Date()
    })

    try {
      const summary = await runWalletDecryption({
        chainStorage,
        walletStorage: this.#walletStorage,
        walletContext,
        chainId,
        ...(params.fromBlock !== undefined && { fromBlock: params.fromBlock }),
        ...(params.toBlock !== undefined && { toBlock: params.toBlock }),
        ...(params.batchSize !== undefined && { batchSize: params.batchSize }),
        /**
         * Forward decrypt progress to caller and event subscribers.
         * @param progress - Wallet decryption progress update.
         */
        onProgress: (progress) => {
          params.onProgress?.(progress)
          this.#emitProgress(progress, chainId, walletId)
        }
      })

      if (summary.notesAdded > 0 || summary.notesSpent > 0) {
        this.#emit('balance:update', {
          walletId,
          chainId,
          balances: await this.#balanceService.getBalances(walletId, chainId, 'all'),
          notesAdded: summary.notesAdded,
          notesSpent: summary.notesSpent,
          timestamp: new Date()
        })
      }

      this.#emit('sync:complete', {
        walletId,
        chainId,
        phase: 'decrypt',
        blocksScanned: summary.blocksScanned,
        notesAdded: summary.notesAdded,
        notesSpent: summary.notesSpent,
        durationMs: Date.now() - startedAt,
        timestamp: new Date()
      })

      return summary
    } catch (err) {
      this.#emit('sync:error', {
        walletId,
        chainId,
        phase: 'decrypt',
        error: toError(err),
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
    const startedAt = Date.now()
    const outerToBlock = params.toBlock ?? params.endBlock

    this.#emit('sync:start', {
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

      this.#emit('sync:complete', {
        walletId,
        chainId,
        phase: 'sync',
        blocksScanned: decrypt.blocksScanned,
        notesAdded: decrypt.notesAdded,
        notesSpent: decrypt.notesSpent,
        durationMs: Date.now() - startedAt,
        timestamp: new Date()
      })

      return {
        scan: { lastBlock },
        decrypt,
        ...(poi !== undefined && { poi })
      }
    } catch (err) {
      this.#emit('sync:error', {
        walletId,
        chainId,
        phase: 'sync',
        error: toError(err),
        timestamp: new Date()
      })
      throw err
    }
  }

  /**
   * Refresh PPOI status for a PPOI-enabled network after sync.
   * @param walletId - Wallet whose notes should be refreshed.
   * @param chainId - Chain ID to scope note updates.
   * @param network - Network whose PPOI config applies.
   * @param onProgress - Optional sync progress callback.
   * @returns PPOI refresh summary.
   */
  #refreshPoiStatusForNetwork (
    walletId: string,
    chainId: number,
    network: NetworkName,
    onProgress?: (progress: SyncProgress) => void
  ): Promise<RefreshSummary> {
    this.#assertPoiNodeUrls(network)
    const service = new PoiStatusService({
      walletStorage: this.#walletStorage,
      network,
      poiNodeClient: new PoiNodeClient({ poiNodeUrls: this.#poiNodeUrls })
    })
    return service.refresh(walletId, chainId, {
      ...(onProgress !== undefined && { onProgress })
    })
  }

  /**
   * Ensure configured PPOI networks have usable node URLs.
   * @param network - Network to validate.
   */
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
  async close (): Promise<void> {
    this.#closed = true
    this.#bus.removeAllListeners()
    await this.#engine.destroy()
    if (this.#ownsWalletDB) {
      await closeWalletDB(this.#walletDB)
    }
  }

  /**
   * Read the persisted chain cursor before scan opens or advances the DB.
   * @param chainId - Chain ID for the configured network.
   * @returns Previous persisted last scanned block, if any.
   */
  async #getPreviousChainLastBlock (chainId: number): Promise<bigint | undefined> {
    if (this.#engine.storage) {
      return (await this.#engine.storage.getSyncState(chainId))?.lastBlockHeight
    }

    const chainDbPath = path.join(this.#dataDir, 'chains', `${chainId}`, 'chain.db')
    if (!existsSync(chainDbPath)) {
      return undefined
    }

    const chainDB = await createChainDB({ path: chainDbPath })
    try {
      return (await createChainStorage(chainDB).getSyncState(chainId))?.lastBlockHeight
    } finally {
      await closeChainDB(chainDB)
    }
  }

  /**
   * Emit an event when the client is still open.
   * @param event - Event name.
   * @param payload - Event payload.
   */
  #emit<E extends keyof RailgunEventMap> (
    event: E,
    payload: RailgunEventMap[E]
  ): void {
    if (this.#closed) return
    this.#bus.emit(event, payload)
  }

  /**
   * Map internal sync progress to public event payloads.
   * @param progress - Internal sync progress update.
   * @param chainId - Chain ID for the event payload.
   * @param walletId - Optional wallet ID for wallet-scoped phases.
   */
  #emitProgress (
    progress: SyncProgress,
    chainId: number,
    walletId?: string
  ): void {
    if (progress.phase === SyncPhase.PoiRefresh) {
      return
    }

    const payload: SyncProgressEvent = {
      ...(walletId !== undefined && { walletId }),
      chainId,
      phase: progress.phase === SyncPhase.Scan ? 'scan' : 'decrypt',
      fromBlock: progress.fromBlock,
      toBlock: progress.toBlock,
      currentBlock: progress.currentBlock,
      blocksScanned: progress.blocksScanned,
      notesAdded: progress.notesAdded,
      notesSpent: progress.notesSpent,
      timestamp: new Date()
    }
    this.#emit('sync:progress', payload)
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

/**
 * Convert thrown values to Error instances.
 * @param err - Thrown value.
 * @returns Error instance.
 */
function toError (err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

export { RailgunClient, SyncPhase }
export type {
  BalanceMode,
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
