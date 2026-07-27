import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'
import type { ChainStorage, WalletStorage } from '@railgun-reloaded/storage'

import {
  clonePoiNodeUrls,
  findNetworkByChainId,
  hasUsablePoiNodeUrls,
  makeScanOnBatch
} from './client-helpers.js'
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
import type { ShieldParams, ShieldResult } from './shield/shield.js'
import { shield } from './shield/shield.js'
import type { DecryptSummary, SyncProgress } from './sync/wallet-decryptor.js'
import { runWalletDecryption } from './sync/wallet-decryptor.js'

type RailgunClientCoreEngine = {
  setDataSource: (dataSource: SourceAggregator<EVMBlock>) => void
  setNetwork: (networkName: NetworkName) => Promise<void>
  scan: (options?: {
    endBlock?: bigint | undefined
    onBatch?: ((startHeight: bigint, lastBlock: bigint) => void) | undefined
    persistRailgunTransactions?: boolean | undefined
  }) => Promise<bigint | undefined>
  storage: ChainStorage | undefined
}

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
  /** Chain ID matching the data already in chain storage. */
  chainId: number
  /** Override the resumable cursor; defaults to `scanState.lastScannedBlock + 1`. */
  fromBlock?: bigint
  /** Stop point; defaults to chain storage's `syncState.lastBlockHeight`. */
  toBlock?: bigint
  /** Block-range chunk size for chain storage queries. Defaults to 10_000. */
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
  /** Stop point for decryption; defaults to chain storage's tip. */
  toBlock?: bigint
  /** Decryption block-range chunk size. Defaults to 10_000. */
  batchSize?: bigint
  /** Refresh PPOI status after decryption on PPOI networks. Defaults to true. */
  refreshPoi?: boolean
  /** Fired per batch from all sync phases. `phase` distinguishes the source. */
  onProgress?: (progress: SyncProgress) => void
}

/**
 * Combined result of a `sync()` call: the scan outcome plus the wallet
 * decryption summary.
 */
type SyncSummary = {
  scan: { lastBlock: bigint | undefined }
  decrypt: DecryptSummary
  poi?: RefreshSummary
}

type RailgunClientCoreOptions<T extends RailgunClientCoreEngine> = {
  engine: T
  walletStorage: WalletStorage
  poiNodeUrls?: Partial<Record<NetworkName, string[]>>
  missingChainStorageMessage?: string
}

const EMPTY_REFRESH_SUMMARY: RefreshSummary = {
  checked: 0,
  updated: 0,
  skipped: 0,
  failed: 0
}

/**
 * Runtime-neutral Railgun client behavior over injected storage and engine
 * contracts. Node and browser clients own only lifecycle and event concerns.
 */
class RailgunClientCore<T extends RailgunClientCoreEngine> {
  /** Underlying wallet-service instance. */
  readonly #walletService: WalletService

  /** Read API over live wallet notes. */
  readonly #balanceService: BalanceService

  /** Wallet storage holding encrypted wallets and decrypted notes. */
  readonly #walletStorage: WalletStorage

  /** Chain-sync engine supplied by the runtime-specific wrapper. */
  readonly #engine: T

  /** PPOI node URLs passed at construction, validated lazily per network. */
  readonly #poiNodeUrls: Partial<Record<NetworkName, string[]>>

  /** Error message used when decrypt runs before chain storage exists. */
  readonly #missingChainStorageMessage: string

  /**
   * Wire shared client behavior around injected storage and engine contracts.
   * @param options - Engine, wallet storage, PPOI URLs, and optional errors.
   */
  constructor (options: RailgunClientCoreOptions<T>) {
    this.#walletStorage = options.walletStorage
    this.#walletService = new WalletService(this.#walletStorage)
    this.#balanceService = new BalanceService(this.#walletStorage)
    this.#poiNodeUrls = clonePoiNodeUrls(options.poiNodeUrls)
    this.#engine = options.engine
    this.#missingChainStorageMessage = options.missingChainStorageMessage ??
      'Decrypt failed: chain storage not initialized — call scan() first'
  }

  /**
   * Runtime-specific chain engine.
   * @returns Engine instance supplied at construction.
   */
  get engine (): T {
    return this.#engine
  }

  /**
   * Eagerly initialize the cryptography libraries this client depends on.
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
   * @returns Decrypted notes from wallet storage.
   */
  getNotes (
    walletId: string,
    chainId: number,
    options?: { unspent?: boolean }
  ): Promise<DecryptedNote[]> {
    return this.#balanceService.getNotes(walletId, chainId, options)
  }

  /**
   * Drain the supplied data source into chain storage for `network`.
   * @param params - Sync target plus optional bounds.
   * @returns Last block number written, or `undefined` when the source had
   *   nothing to yield.
   */
  async scan (params: ScanParams): Promise<bigint | undefined> {
    this.#engine.setDataSource(params.dataSource)
    await this.#engine.setNetwork(params.network)
    const onProgress = params.onProgress
    return this.#engine.scan({
      ...(params.endBlock !== undefined && { endBlock: params.endBlock }),
      ...(onProgress !== undefined && {
        onBatch: makeScanOnBatch(onProgress, params.endBlock)
      })
    })
  }

  /**
   * Decrypt the wallet's notes from chain storage into wallet storage.
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
    const walletContext = await this.#walletService.loadWallet(walletId, encryptionKey)
    return this.decryptWalletContext(walletContext, params)
  }

  /**
   * Decrypt notes for an already-loaded wallet context.
   * @param walletContext - Wallet context returned by `loadWallet`.
   * @param params - Decryption target plus optional bounds.
   * @returns Summary of blocks scanned and notes added/spent.
   */
  async decryptWalletContext (
    walletContext: WalletContext,
    params: DecryptParams
  ): Promise<DecryptSummary> {
    const chainStorage = this.#engine.storage
    if (!chainStorage) {
      throw new Error(this.#missingChainStorageMessage)
    }

    return runWalletDecryption({
      chainStorage,
      walletStorage: this.#walletStorage,
      walletContext,
      chainId: params.chainId,
      ...(params.fromBlock !== undefined && { fromBlock: params.fromBlock }),
      ...(params.toBlock !== undefined && { toBlock: params.toBlock }),
      ...(params.batchSize !== undefined && { batchSize: params.batchSize }),
      ...(params.onProgress !== undefined && { onProgress: params.onProgress })
    })
  }

  /**
   * Convenience composer: scan chain storage, decrypt wallet notes, and
   * optionally refresh PPOI status on PPOI networks.
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
      ? await this.refreshPoiStatusForNetwork(
        walletId,
        chainId,
        params.network,
        params.onProgress
      )
      : undefined

    return {
      scan: { lastBlock },
      decrypt,
      ...(poi !== undefined && { poi })
    }
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
    return this.refreshPoiStatusForNetwork(walletId, chainId, network)
  }

  /**
   * Refresh PPOI status for a PPOI-enabled network after sync.
   * @param walletId - Wallet whose notes should be refreshed.
   * @param chainId - Chain ID to scope note updates.
   * @param network - Network whose PPOI config applies.
   * @param onProgress - Optional sync progress callback.
   * @returns PPOI refresh summary.
   */
  refreshPoiStatusForNetwork (
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
   * Build an unsigned transaction shielding ERC20 or ERC721 tokens to a 0zk
   * recipient.
   *
   * Resolves `network` to its chain ID and delegates to the `shield()` free
   * function. `tokenType` selects the standard and defaults to ERC20.
   *
   * Callers derive `shieldPrivateKey` by signing the shield key derivation
   * message, and remain responsible for the token allowance or approval, gas
   * estimation, signing, and sending.
   * @param params - Token, recipient, and shield private key.
   * @param network - Network whose RAILGUN contract receives the shield.
   * @returns The unsigned shield transaction.
   */
  shield (params: ShieldParams, network: NetworkName): Promise<ShieldResult> {
    return shield(params, NETWORK_CONFIG[network].chainID)
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
}

export { RailgunClientCore }
export type {
  BalanceMode,
  DecryptedNote,
  DecryptSummary,
  DecryptParams,
  RailgunClientCoreEngine,
  RailgunClientCoreOptions,
  ScanParams,
  ShieldParams,
  ShieldResult,
  SyncParams,
  SyncProgress,
  SyncSummary,
  TokenBalance
}
