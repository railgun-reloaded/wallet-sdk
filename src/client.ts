import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { DataSource, EVMBlock } from '@railgun-reloaded/scanner'
import type { ChainDB, WalletDB } from '@railgun-reloaded/storage'
import {
  closeWalletDB,
  createWalletDB
} from '@railgun-reloaded/storage'

import { RailgunEngine } from './engine'
import type { NetworkName } from './network-config'
import { NETWORK_CONFIG } from './network-config'
import type {
  CreateWalletParams,
  WalletContext,
  WalletInfo
} from './services/wallet/wallet-service'
import { WalletService } from './services/wallet/wallet-service'
import type { DecryptSummary, SyncProgress } from './sync/wallet-decryptor'
import { runWalletDecryption, SyncPhase } from './sync/wallet-decryptor'

/**
 * Inputs for `RailgunClient.scan()`.
 */
type ScanParams = {
  network: NetworkName
  dataSource: DataSource<EVMBlock>
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
  dataSource: DataSource<EVMBlock>
  /** Inclusive ceiling on chain ingestion. */
  endBlock?: bigint
  /** Override the wallet decryption cursor; defaults to scanState + 1. */
  fromBlock?: bigint
  /** Stop point for decryption; defaults to chain.db's tip. */
  toBlock?: bigint
  /** Decryption block-range chunk size. Defaults to 10_000. */
  batchSize?: bigint
  /** Fired per batch from both phases. `phase` distinguishes scan vs decrypt. */
  onProgress?: (progress: SyncProgress) => void
}

/**
 * Combined result of a `sync()` call: the engine scan outcome plus the
 * wallet decryption summary.
 */
type SyncSummary = {
  scan: { lastBlock: bigint | undefined }
  decrypt: DecryptSummary
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
}

const DEFAULT_DATA_DIR = './.railgun'

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

/**
 * Top-level entry point for @railgun-reloaded/wallet-sdk.
 *
 * Composes WalletService (persistent, encrypted wallet lifecycle) with
 * RailgunEngine (chain sync). Thin orchestrator — no business logic.
 */
class RailgunClient {
  /** Underlying wallet-service instance. */
  readonly #walletService: WalletService

  /** The wallet DB in use (either injected or auto-created). */
  readonly #walletDB: WalletDB

  /** True when this client constructed its own DB and is responsible for closing it. */
  readonly #ownsWalletDB: boolean

  /** RailgunEngine instance exposed via the `engine` getter. */
  readonly #engine: RailgunEngine

  /**
   * Construct a RailgunClient.
   * @param options - Optional `{ dataDir?, walletDB?, chainDB? }`. Injected
   *   DBs are not owned by the client and won't be closed by `close()`.
   *   When omitted, DBs are created under `dataDir` (default: `./.railgun`).
   */
  constructor (options: RailgunClientOptions = {}) {
    const dataDir = options.dataDir ?? DEFAULT_DATA_DIR

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
   * The underlying RailgunEngine for chain sync operations.
   * @returns The engine instance.
   */
  get engine (): RailgunEngine {
    return this.#engine
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
  scan (params: ScanParams): Promise<bigint | undefined> {
    this.#engine.setDataSource(params.dataSource)
    this.#engine.setNetwork(params.network)
    return this.#engine.scan({
      endBlock: params.endBlock,
      ...(params.onProgress && { onBatch: makeScanOnBatch(params.onProgress, params.endBlock) })
    })
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
    return runWalletDecryption({
      chainDb,
      walletDb: this.#walletDB,
      walletContext,
      chainId: params.chainId,
      ...(params.fromBlock !== undefined && { fromBlock: params.fromBlock }),
      ...(params.toBlock !== undefined && { toBlock: params.toBlock }),
      ...(params.batchSize !== undefined && { batchSize: params.batchSize }),
      ...(params.onProgress !== undefined && { onProgress: params.onProgress })
    })
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
    const lastBlock = await this.scan({
      network: params.network,
      dataSource: params.dataSource,
      ...(params.endBlock !== undefined && { endBlock: params.endBlock }),
      ...(params.onProgress !== undefined && { onProgress: params.onProgress })
    })
    const decrypt = await this.decrypt(walletId, encryptionKey, {
      chainId: NETWORK_CONFIG[params.network].chainID,
      ...(params.fromBlock !== undefined && { fromBlock: params.fromBlock }),
      ...(params.toBlock !== undefined && { toBlock: params.toBlock }),
      ...(params.batchSize !== undefined && { batchSize: params.batchSize }),
      ...(params.onProgress !== undefined && { onProgress: params.onProgress })
    })
    return { scan: { lastBlock }, decrypt }
  }

  /**
   * Release resources owned by this client: tears down the engine (which
   * closes its chain DB only when it owns it, and destroys the configured
   * data source when one was set) and closes the wallet DB only when it
   * was created internally. Injected DBs remain the caller's responsibility.
   */
  close (): void {
    this.#engine.destroy()
    if (this.#ownsWalletDB) {
      closeWalletDB(this.#walletDB)
    }
  }
}

export { RailgunClient, SyncPhase }
export type { DecryptParams, RailgunClientOptions, ScanParams, SyncParams, SyncProgress, SyncSummary }
