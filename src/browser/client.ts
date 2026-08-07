import type { ChainStorage, WalletStorage } from '@railgun-reloaded/storage'

import type {
  BalanceMode,
  BuildShieldParams,
  BuildShieldResult,
  DecryptParams,
  DecryptSummary,
  DecryptedNote,
  ScanParams,
  ShieldParams,
  ShieldResult,
  SyncParams,
  SyncSummary,
  TokenBalance
} from '../client-core.js'
import { RailgunClientCore } from '../client-core.js'
import type { NetworkName } from '../network-config.js'
import type { RefreshSummary, WalletBalanceBucket } from '../poi/index.js'
import type {
  CreateWalletParams,
  WalletContext,
  WalletInfo
} from '../services/wallet/wallet-service.js'

import { RailgunEngine } from './engine.js'

/**
 * Options for constructing a browser RailgunClient. Both storages are
 * required and caller-owned: open them with an adapter such as
 * `@railgun-reloaded/storage/browser` and close/delete them yourself.
 */
type RailgunClientOptions = {
  /** Chain storage the engine scans into. */
  chainStorage: ChainStorage

  /** Wallet storage holding encrypted wallets and decrypted notes. */
  walletStorage: WalletStorage

  /**
   * PPOI node URLs by network. These are caller-supplied rather than protocol
   * config because node operators and failover choices are deployment-specific.
   * Presence is validated only when a PPOI-aware operation runs on a network
   * that requires PPOI.
   */
  poiNodeUrls?: Partial<Record<NetworkName, string[]>>
}

/**
 * Browser entry point for @railgun-reloaded/wallet-sdk.
 *
 * Mirrors the Node `RailgunClient` API where practical, but never touches a
 * filesystem or opens databases: chain and wallet storage contracts are
 * injected at construction and remain caller-owned. `close()` tears down the
 * data source only.
 */
class RailgunClient {
  /** Runtime-neutral client behavior bound to the browser engine. */
  readonly #core: RailgunClientCore<RailgunEngine>

  /**
   * Wire up services around the injected storage contracts. Private for
   * symmetry with the Node client — use the static `create()` factory.
   * @param options - Construction options.
   */
  private constructor (options: RailgunClientOptions) {
    this.#core = new RailgunClientCore({
      engine: new RailgunEngine({ chainStorage: options.chainStorage }),
      walletStorage: options.walletStorage,
      ...(options.poiNodeUrls !== undefined && { poiNodeUrls: options.poiNodeUrls })
    })
  }

  /**
   * Create a browser RailgunClient around injected storage contracts.
   * @param options - Required `{ chainStorage, walletStorage }` plus optional
   *   PPOI node URLs. Storages are caller-owned and never closed by the client.
   * @returns Ready-to-use client.
   */
  static async create (options: RailgunClientOptions): Promise<RailgunClient> {
    return new RailgunClient(options)
  }

  /**
   * Eagerly initialize the cryptography libraries this client depends on.
   * @returns A promise that resolves once the cryptography libraries are ready.
   */
  initialize (): Promise<void> {
    return this.#core.initialize()
  }

  /**
   * Create and persist an encrypted wallet. Delegates to WalletService.
   * @param params - Mnemonic + encryption key + optional index/name.
   * @returns Decrypt-free WalletInfo.
   */
  createWallet (params: CreateWalletParams): Promise<WalletInfo> {
    return this.#core.createWallet(params)
  }

  /**
   * Load a wallet by ID. Delegates to WalletService.
   * @param walletId - Wallet to load.
   * @param encryptionKey - 32-byte key used at creation time.
   * @returns Full WalletContext (minus spending key).
   */
  loadWallet (walletId: string, encryptionKey: Uint8Array): Promise<WalletContext> {
    return this.#core.loadWallet(walletId, encryptionKey)
  }

  /**
   * List all stored wallets (decrypt-free). Delegates to WalletService.
   * @returns Array of WalletInfo sorted by createdAt ASC.
   */
  listWallets (): Promise<WalletInfo[]> {
    return this.#core.listWallets()
  }

  /**
   * Delete a wallet by ID. Idempotent. Delegates to WalletService.
   * @param walletId - Wallet to remove.
   * @returns Resolves when the delete completes.
   */
  deleteWallet (walletId: string): Promise<void> {
    return this.#core.deleteWallet(walletId)
  }

  /**
   * Read ERC-20 balances for a wallet on a given chain from live unspent notes.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param chainId - Chain id to scope the lookup to.
   * @param mode - Balance mode: default spendable, all unspent, or one bucket.
   * @returns Token balances grouped by token.
   */
  getBalances (
    walletId: string,
    chainId: number,
    mode?: BalanceMode
  ): Promise<TokenBalance[]> {
    return this.#core.getBalances(walletId, chainId, mode)
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
    return this.#core.getBalancesByBucket(walletId, chainId)
  }

  /**
   * Read decrypted notes with protocol and optional POI spend state.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param chainId - Chain id to scope the lookup to.
   * @param options - Optional note filtering.
   * @param options.unspent - When true, only return unspent notes.
   * @returns Decrypted notes from wallet storage.
   */
  getNotes (
    walletId: string,
    chainId: number,
    options?: { unspent?: boolean }
  ): Promise<DecryptedNote[]> {
    return this.#core.getNotes(walletId, chainId, options)
  }

  /**
   * The underlying portable RailgunEngine for chain sync operations.
   * @returns The engine instance.
   */
  get engine (): RailgunEngine {
    return this.#core.engine
  }

  /**
   * Drain the supplied data source into chain storage for `network`.
   * @param params - Sync target plus optional bounds.
   * @returns Last block number written, or `undefined` when the source had
   *   nothing to yield.
   */
  scan (params: ScanParams): Promise<bigint | undefined> {
    return this.#core.scan(params)
  }

  /**
   * Decrypt the wallet's notes from chain storage into wallet storage.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param encryptionKey - Same 32-byte key used at wallet creation time.
   * @param params - Decryption target plus optional bounds.
   * @returns Summary of blocks scanned and notes added/spent.
   */
  decrypt (
    walletId: string,
    encryptionKey: Uint8Array,
    params: DecryptParams
  ): Promise<DecryptSummary> {
    return this.#core.decrypt(walletId, encryptionKey, params)
  }

  /**
   * Convenience composer: drain chain state into chain storage (`scan`) then
   * decrypt the wallet's notes into wallet storage (`decrypt`), optionally
   * refreshing PPOI status on PPOI networks.
   * @param walletId - Wallet ID to decrypt for.
   * @param encryptionKey - 32-byte key used at wallet creation time.
   * @param params - Network + data source + optional bounds.
   * @returns Combined summary: last scanned block + decryption counters.
   */
  sync (
    walletId: string,
    encryptionKey: Uint8Array,
    params: SyncParams
  ): Promise<SyncSummary> {
    return this.#core.sync(walletId, encryptionKey, params)
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
    return this.#core.refreshPoiStatus(walletId, chainId)
  }

  /**
   * Build an unsigned shield transaction without signing or network access.
   * @param params - Token, recipient, and caller-derived shield private key.
   * @param network - Network whose RAILGUN contract receives the shield.
   * @returns The unsigned shield transaction.
   */
  buildShield (
    params: BuildShieldParams,
    network: NetworkName
  ): Promise<BuildShieldResult> {
    return this.#core.buildShield(params, network)
  }

  /**
   * Derive a shield key, approve the token, submit, and parse the receipt.
   * @param params - Token, recipient, signer, and execution options.
   * @param network - Network whose RAILGUN contract receives the shield.
   * @returns Parsed shield result for the confirmed transaction.
   * @throws {ShieldEventMissingError} If the confirmed receipt carries no Shield event.
   */
  shield (
    params: ShieldParams,
    network: NetworkName
  ): Promise<ShieldResult> {
    return this.#core.shield(params, network)
  }

  /**
   * Release resources owned by this client: tears down the data source when
   * one was set. The injected storage contracts are caller-owned — close or
   * delete them through the adapter that created them.
   */
  async close (): Promise<void> {
    await this.#core.engine.destroy()
  }
}

export { RailgunClient }
export type {
  BuildShieldParams,
  BuildShieldResult,
  DecryptParams,
  RailgunClientOptions,
  ScanParams,
  ShieldParams,
  ShieldResult,
  SyncParams,
  SyncSummary
}
