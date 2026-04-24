import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { WalletDB } from '@railgun-reloaded/storage'
import {
  closeWalletDB,
  createWalletDB
} from '@railgun-reloaded/storage'

import { RailgunEngine } from './engine'
import type {
  CreateWalletParams,
  WalletContext,
  WalletInfo
} from './services/wallet/wallet-service'
import { WalletService } from './services/wallet/wallet-service'

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
   * @param options - Optional `{ dataDir?, walletDB? }`. With `walletDB`,
   *   the client won't own or close it; with `dataDir`, the client creates
   *   its own DB at `<dataDir>/wallets.db`.
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
    this.#engine = new RailgunEngine()
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
   */
  deleteWallet (walletId: string): Promise<void> {
    return this.#walletService.deleteWallet(walletId)
  }

  /**
   * Access the underlying RailgunEngine for chain sync operations.
   * @returns The engine instance.
   */
  get engine (): RailgunEngine {
    return this.#engine
  }

  /**
   * Release any resources owned by this client. Only closes the wallet DB
   * if it was constructed internally (injected DBs remain the caller's
   * responsibility).
   */
  close (): void {
    if (this.#ownsWalletDB) {
      closeWalletDB(this.#walletDB)
    }
  }
}

export { RailgunClient }
export type { RailgunClientOptions }
