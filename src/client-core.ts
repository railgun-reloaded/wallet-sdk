import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'
import type {
  ChainStorage,
  DBTxHistory,
  WalletStorage
} from '@railgun-reloaded/storage'
import type { Hash, TransactionReceipt, WalletClient } from 'viem'
import {
  WaitForTransactionReceiptTimeoutError,
  getAddress,
  isAddressEqual,
  maxUint256
} from 'viem'
import {
  readContract,
  sendTransaction,
  waitForTransactionReceipt,
  writeContract
} from 'viem/actions'

import {
  clonePoiNodeUrls,
  findNetworkByChainId,
  hasUsablePoiNodeUrls,
  makeScanOnBatch
} from './client-helpers.js'
import { ERC20_APPROVAL_ABI, ERC721_APPROVAL_ABI } from './contracts/abi.js'
import type { UnsignedTx } from './contracts/index.js'
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
  ERC721Holding,
  TokenBalance
} from './services/balance/balance-service.js'
import { BalanceService } from './services/balance/balance-service.js'
import type {
  CreateWalletParams,
  WalletContext,
  WalletInfo
} from './services/wallet/wallet-service.js'
import { WalletService } from './services/wallet/wallet-service.js'
import { deriveShieldPrivateKey } from './shield/derivation.js'
import {
  ShieldApprovalRevertedError,
  ShieldEventMissingError,
  ShieldReceiptTimeoutError,
  ShieldSignatureRejectedError,
  ShieldTransactionRevertedError
} from './shield/errors.js'
import type { ShieldReceiptResult as ShieldResult } from './shield/receipt.js'
import { parseShieldReceipt } from './shield/receipt.js'
import type { BuildShieldParams, BuildShieldResult } from './shield/shield.js'
import { buildShield } from './shield/shield.js'
import type { ShieldParams } from './shield/types.js'
import type { DecryptSummary, SyncProgress } from './sync/wallet-decryptor.js'
import { runWalletDecryption } from './sync/wallet-decryptor.js'

type RailgunClientCoreEngine = {
  setDataSource: (dataSource: SourceAggregator<EVMBlock>) => void
  setNetwork: (networkName: NetworkName) => Promise<void>
  scan: (options?: {
    startBlock?: bigint | undefined
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
  /**
   * Inclusive chain ingestion floor on empty storage. Values below the
   * network deployment block are rejected. Ignored when a cursor exists.
   */
  startBlock?: bigint
  /** Inclusive ceiling on chain ingestion. */
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
  /**
   * Inclusive chain ingestion floor on empty storage. Values below the
   * network deployment block are rejected. Ignored when a cursor exists.
   */
  startBlock?: bigint
  /** Inclusive ceiling on chain ingestion. */
  endBlock?: bigint
  /** Override only the wallet decryption cursor; defaults to scanState + 1. */
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

/** Persisted chain-ingestion progress, including the explicit fresh state. */
type SyncCursor =
  | { status: 'never-synced' }
  | { status: 'synced', lastBlockHeight: bigint }

/** One wallet-scoped transaction-history row. */
type TransactionHistoryEntry = DBTxHistory

type RailgunClientCoreOptions<T extends RailgunClientCoreEngine> = {
  engine: T
  walletStorage: WalletStorage
  poiNodeUrls?: Partial<Record<NetworkName, string[]>>
  missingChainStorageMessage?: string
  readPersistedSyncCursor?: (chainId: number) => Promise<bigint | undefined>
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

  /** Runtime-specific persisted cursor reader, when storage is not yet open. */
  readonly #readPersistedSyncCursor: ((chainId: number) => Promise<bigint | undefined>) | undefined

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
    this.#readPersistedSyncCursor = options.readPersistedSyncCursor
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
   * Read unspent private ERC-721 holdings for a wallet on a given chain.
   * @param walletId - Wallet ID returned from `createWallet`/`listWallets`.
   * @param chainId - Chain id to scope the lookup to.
   * @returns ERC-721 contract addresses and token sub-IDs.
   */
  getNFTs (
    walletId: string,
    chainId: number
  ): Promise<ERC721Holding[]> {
    return this.#balanceService.getNFTs(walletId, chainId)
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
   * Record a confirmed shield in wallet-scoped transaction history.
   * @param walletId - Wallet that received the shield.
   * @param chainId - Chain on which the shield confirmed.
   * @param result - Confirmed shield receipt returned by `shield()`.
   * @param timestamp - Timestamp of the confirmed shield block.
   * @returns Resolves once the history row is stored.
   */
  recordShield (
    walletId: string,
    chainId: number,
    result: ShieldResult,
    timestamp: Date
  ): Promise<void> {
    return this.#walletStorage.insertTxHistory({
      id: `${walletId}:${chainId}:${result.txHash}`,
      walletId,
      chainId,
      type: 'shield',
      txid: result.txHash,
      blockNumber: result.receipt.blockNumber,
      timestamp,
      metadata: {
        token: result.commitment.token.tokenAddress.toLowerCase(),
        amount: result.shieldedAmount.toString()
      }
    })
  }

  /**
   * Read stored transaction history for one wallet and chain, newest first.
   * @param walletId - Wallet whose history should be returned.
   * @param chainId - Chain to scope the history query to.
   * @param limit - Optional maximum number of rows to return.
   * @returns Stored wallet transaction history.
   */
  getTransactionHistory (
    walletId: string,
    chainId: number,
    limit?: number
  ): Promise<TransactionHistoryEntry[]> {
    return this.#walletStorage.getTxHistory(walletId, chainId, limit)
  }

  /**
   * Read persisted chain-ingestion progress without exposing engine storage.
   * @param chainId - Chain whose persisted cursor should be returned.
   * @returns Explicit synced or never-synced state.
   */
  async getSyncCursor (chainId: number): Promise<SyncCursor> {
    const lastBlockHeight = this.#readPersistedSyncCursor !== undefined
      ? await this.#readPersistedSyncCursor(chainId)
      : (await this.#engine.storage?.getSyncState(chainId))?.lastBlockHeight

    return lastBlockHeight === undefined
      ? { status: 'never-synced' }
      : { status: 'synced', lastBlockHeight }
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
      ...(params.startBlock !== undefined && { startBlock: params.startBlock }),
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
      ...(params.startBlock !== undefined && { startBlock: params.startBlock }),
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
   * Build an unsigned transaction shielding tokens to a 0zk recipient.
   * @param params - Token, recipient, and caller-derived shield private key.
   * @param network - Network whose RAILGUN contract receives the shield.
   * @returns The unsigned shield transaction.
   * @throws {Error} If `network` has no entry in `NETWORK_CONFIG`.
   */
  buildShield (
    params: BuildShieldParams,
    network: NetworkName
  ): Promise<BuildShieldResult> {
    const config = NETWORK_CONFIG[network]
    if (config === undefined) {
      throw new Error(
        `Unknown network ${String(network)}. Supported networks: ${Object.keys(NETWORK_CONFIG).join(', ')}`
      )
    }

    return buildShield(params, config.chainID)
  }

  /**
   * Derive a shield key, ensure token approval, submit the shield transaction,
   * and parse its V2.1 Shield event.
   * @param params - Token, recipient, signer, and execution options.
   * @param network - Network whose RAILGUN contract receives the shield.
   * @returns Parsed receipt data for the confirmed shield.
   * @throws {ShieldSignatureRejectedError} If key derivation signing fails.
   * @throws {ShieldApprovalRevertedError} If approval fails or reverts.
   * @throws {ShieldTransactionRevertedError} If shield submission fails or reverts.
   * @throws {ShieldReceiptTimeoutError} If either receipt times out.
   * @throws {ShieldEventMissingError} If the confirmed receipt carries no Shield event.
   */
  async shield (
    params: ShieldParams,
    network: NetworkName
  ): Promise<ShieldResult> {
    let key: Uint8Array
    try {
      key = await deriveShieldPrivateKey(params.signer)
    } catch (cause) {
      throw new ShieldSignatureRejectedError(cause)
    }

    const proxy = NETWORK_CONFIG[network].proxyContractAddress
    await this.#ensureAllowance(params, proxy)
    const { transaction } = await this.buildShield({
      ...params,
      shieldPrivateKey: key
    }, network)
    const receipt = await this.#sendAndWait(
      transaction,
      params.signer,
      params.confirmations
    )
    const result = parseShieldReceipt(receipt, proxy)
    if (result === undefined) {
      throw new ShieldEventMissingError(receipt.transactionHash, proxy)
    }
    return result
  }

  /**
   * Ensure the signer has sufficient ERC20 allowance or ERC721 approval.
   * @param params - Shield inputs and approval options.
   * @param proxy - RAILGUN proxy receiving token approval.
   */
  async #ensureAllowance (params: ShieldParams, proxy: string): Promise<void> {
    if (params.skipApprove === true) {
      return
    }

    const account = params.signer.account
    const tokenAddress = getAddress(params.tokenAddress)
    const spender = getAddress(proxy)
    if (account === undefined) {
      throw new ShieldApprovalRevertedError(
        tokenAddress,
        new Error('Shield approval requires a wallet client account.')
      )
    }

    let txHash: Hash | undefined
    try {
      if (params.tokenType === 'ERC721') {
        if (params.approvalMode === 'unlimited') {
          const approved = await readContract(params.signer, {
            address: tokenAddress,
            abi: ERC721_APPROVAL_ABI,
            functionName: 'isApprovedForAll',
            args: [account.address, spender]
          })
          if (approved) return

          txHash = await writeContract(params.signer, {
            account,
            chain: params.signer.chain,
            address: tokenAddress,
            abi: ERC721_APPROVAL_ABI,
            functionName: 'setApprovalForAll',
            args: [spender, true]
          })
        } else {
          const approved = await readContract(params.signer, {
            address: tokenAddress,
            abi: ERC721_APPROVAL_ABI,
            functionName: 'getApproved',
            args: [params.tokenSubID]
          })
          if (isAddressEqual(approved, spender)) return

          txHash = await writeContract(params.signer, {
            account,
            chain: params.signer.chain,
            address: tokenAddress,
            abi: ERC721_APPROVAL_ABI,
            functionName: 'approve',
            args: [spender, params.tokenSubID]
          })
        }
      } else {
        const allowance = await readContract(params.signer, {
          address: tokenAddress,
          abi: ERC20_APPROVAL_ABI,
          functionName: 'allowance',
          args: [account.address, spender]
        })
        if (allowance >= params.amount) return

        txHash = await writeContract(params.signer, {
          account,
          chain: params.signer.chain,
          address: tokenAddress,
          abi: ERC20_APPROVAL_ABI,
          functionName: 'approve',
          args: [
            spender,
            params.approvalMode === 'unlimited' ? maxUint256 : params.amount
          ]
        })
      }

      const receipt = await this.#waitForReceipt(
        txHash,
        params.signer,
        params.confirmations,
        'approval'
      )
      if (receipt.status === 'reverted') {
        throw new ShieldApprovalRevertedError(tokenAddress, receipt)
      }
    } catch (cause) {
      if (
        cause instanceof ShieldApprovalRevertedError ||
        cause instanceof ShieldReceiptTimeoutError
      ) {
        throw cause
      }
      throw new ShieldApprovalRevertedError(tokenAddress, cause)
    }
  }

  /**
   * Submit an unsigned shield call and wait for its configured confirmations.
   * @param transaction - Call target and calldata from `buildShield`.
   * @param signer - Wallet client used to submit the call.
   * @param confirmations - Required confirmation count.
   * @returns Confirmed shield receipt.
   */
  async #sendAndWait (
    transaction: UnsignedTx,
    signer: WalletClient,
    confirmations?: number
  ): Promise<TransactionReceipt> {
    const account = signer.account
    if (account === undefined) {
      throw new ShieldTransactionRevertedError(
        new Error('Shield submission requires a wallet client account.')
      )
    }

    let txHash: Hash
    try {
      txHash = await sendTransaction(signer, {
        account,
        chain: signer.chain,
        to: transaction.to,
        data: transaction.data
      })
    } catch (cause) {
      throw new ShieldTransactionRevertedError(cause)
    }

    let receipt: TransactionReceipt
    try {
      receipt = await this.#waitForReceipt(
        txHash,
        signer,
        confirmations,
        'shield'
      )
    } catch (cause) {
      if (cause instanceof ShieldReceiptTimeoutError) {
        throw cause
      }
      throw new ShieldTransactionRevertedError(cause, txHash)
    }
    if (receipt.status === 'reverted') {
      throw new ShieldTransactionRevertedError(receipt, txHash)
    }
    return receipt
  }

  /**
   * Wait for a transaction receipt and map viem timeouts to the public error.
   * @param txHash - Submitted transaction hash.
   * @param signer - Client whose transport is used for receipt polling.
   * @param confirmations - Required confirmation count.
   * @param stage - Approval or shield stage.
   * @returns Confirmed transaction receipt.
   */
  async #waitForReceipt (
    txHash: Hash,
    signer: WalletClient,
    confirmations: number | undefined,
    stage: 'approval' | 'shield'
  ): Promise<TransactionReceipt> {
    try {
      return await waitForTransactionReceipt(signer, {
        hash: txHash,
        ...(confirmations !== undefined && { confirmations })
      })
    } catch (cause) {
      if (cause instanceof WaitForTransactionReceiptTimeoutError) {
        throw new ShieldReceiptTimeoutError(stage, txHash, cause)
      }
      throw cause
    }
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
  ERC721Holding,
  DecryptSummary,
  DecryptParams,
  RailgunClientCoreEngine,
  RailgunClientCoreOptions,
  ScanParams,
  BuildShieldParams,
  BuildShieldResult,
  ShieldParams,
  ShieldResult,
  SyncCursor,
  SyncParams,
  SyncProgress,
  SyncSummary,
  TransactionHistoryEntry,
  TokenBalance
}
