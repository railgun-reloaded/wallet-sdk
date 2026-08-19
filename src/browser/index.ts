export { RailgunClient } from './client.js'
export type {
  DecryptParams,
  RailgunClientOptions,
  ScanParams,
  SyncCursor,
  SyncParams,
  SyncSummary,
  TransactionHistoryEntry
} from './client.js'
export { RailgunEngine } from './engine.js'

export type {
  BalanceMode,
  DecryptedNote,
  ERC721Holding,
  TokenBalance
} from '../services/balance/balance-service.js'

export { TokenType } from '@railgun-reloaded/wallet-node'

export type {
  HistoryTokenAmount,
  ReceivedKind,
  ReceivedTokenAmount,
  TransactionCategory,
  UnshieldTokenAmount
} from '../history/index.js'

export type { DecryptSummary, SyncProgress } from '../sync/wallet-decryptor.js'
export { SyncPhase } from '../sync/wallet-decryptor.js'

export { initializeCrypto } from '../init/crypto.js'

export { Mnemonic } from '../mnemonic.js'

export { createDataSource } from '../data-source.js'
export type { RailgunDataSource } from '../data-source.js'

export type { NetworkConfig } from '../network-config.js'
export { NETWORK_CONFIG, NetworkName, UnsupportedNetworkError } from '../network-config.js'

export type { UnsignedTx } from '../contracts/index.js'
export {
  SHIELD_ABI,
  SHIELD_EVENT_ABI,
  UnsupportedChainError,
  UnsupportedTokenTypeError,
  buildShieldTransaction
} from '../contracts/index.js'

export {
  InvalidShieldAmountError,
  InvalidShieldPrivateKeyError,
  InvalidTokenSubIDError,
  SHIELD_PRIVATE_KEY_SIGNATURE_MESSAGE,
  ShieldApprovalRevertedError,
  ShieldEventMissingError,
  ShieldFeeReadError,
  ShieldReceiptTimeoutError,
  ShieldSignatureRejectedError,
  ShieldStage,
  ShieldTransactionRevertedError,
  UnexpectedShieldFieldError,
  buildShield,
  computeShieldFee,
  deriveShieldPrivateKey,
  parseShieldReceipt,
  readShieldFee,
  readShieldFeeForNetwork,
  shieldPrivateKeyFromSignature
} from '../shield/index.js'
export type {
  BuildShieldParams,
  BuildShieldResult,
  ShieldApprovalMode,
  ShieldCommitmentPreimage,
  ShieldParams,
  ShieldProgress,
  ShieldReceiptResult,
  ShieldResult
} from '../shield/index.js'

export { deriveWalletKeys } from '../services/wallet/keys.js'
export type { WalletKeys } from '../services/wallet/keys.js'

export { generateWalletId } from '../services/wallet/wallet-id.js'

export type {
  CreateWalletParams,
  WalletContext,
  WalletInfo
} from '../services/wallet/wallet-service.js'

export {
  InvalidEncryptionKeyError,
  InvalidMnemonicError,
  WalletAlreadyExistsError,
  WalletNotFoundError
} from '../services/wallet/errors.js'

export {
  BlindedCommitmentType,
  CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY,
  GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS,
  POIJSONRPCMethod,
  POIListType,
  POIStatus,
  POI_NODE_CLIENT_DEFAULT_TIMEOUT_MS,
  PoiNodeAllUrlsFailedError,
  PoiNodeClient,
  PoiNodeNetworkError,
  PoiNodeRpcError,
  PoiNodeUrlsRequiredError,
  PoiStatusRefreshError,
  PoiStatusService,
  SEPOLIA_POI_CONFIG,
  SEPOLIA_REQUIRED_LIST_KEYS,
  SEPOLIA_REQUIRED_POI_LISTS,
  TXIDVersion,
  WalletBalanceBucket,
  classifyNote,
  classifyNoteSpendState,
  classifyPoi,
  getRequiredListKeys,
  isPOIRequired,
  isSpendableProtocol,
  toWalletBalanceBucket
} from '../poi/index.js'
export type {
  BlindedCommitmentData,
  FetchLike,
  FetchRequest,
  FetchResponse,
  GetPOIsPerListParams,
  GetPOIsPerListWireParams,
  JsonRpcErrorPayload,
  JsonRpcRequest,
  JsonRpcSuccess,
  NetworkPoiConfig,
  NoteSpendState,
  POIList,
  POIsPerList,
  POIsPerListResponse,
  PoiClassification,
  PoiNodeClientOptions,
  PoiStatusClient,
  PoiStatusRefreshErrorCode,
  PoiStatusServiceOptions,
  RefreshOptions,
  RefreshSummary,
  RequiredListKey
} from '../poi/index.js'

export {
  BalanceSyncScheduler,
  BalanceSyncSchedulerStoppedError
} from '../services/balance/balance-sync-scheduler.js'
export type {
  BalanceSyncBackoffOptions,
  BalanceSyncDataSourceFactory,
  BalanceSyncHeadProvider,
  BalanceSyncRefreshOptions,
  BalanceSyncRefreshReason,
  BalanceSyncSchedulerClient,
  BalanceSyncSchedulerConfig,
  BalanceSyncSchedulerErrorContext,
  BalanceSyncSchedulerState,
  BalanceSyncSchedulerStatus,
  BalanceSyncSchedulerWallet,
  BalanceSyncSchedulerWalletState
} from '../services/balance/balance-sync-scheduler.js'
