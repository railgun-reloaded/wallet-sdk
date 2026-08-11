/**
 * Node entry for @railgun-reloaded/wallet-sdk.
 *
 * Keeps filesystem-backed wallet and chain database ownership, event
 * emission, and snapshot bootstrap exports behind an explicit Node subpath.
 */

export { RailgunClient } from '../client.js'
export type {
  BalanceMode,
  DecryptedNote,
  DecryptParams,
  RailgunClientOptions,
  ScanParams,
  SyncParams,
  SyncProgress,
  SyncSummary,
  TokenBalance
} from '../client.js'

export type { DecryptSummary } from '../sync/wallet-decryptor.js'
export { SyncPhase } from '../sync/wallet-decryptor.js'

export type {
  BalanceUpdateEvent,
  BusErrorEvent,
  EventFilter,
  EventHandler,
  RailgunEventMap,
  SyncCompleteEvent,
  SyncErrorEvent,
  SyncPhaseTag,
  SyncProgressEvent,
  SyncStartEvent
} from '../events/index.js'

export { RailgunEngine } from '../engine.js'

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
  ShieldReceiptResult,
  ShieldResult
} from '../shield/index.js'

export {
  COMMITMENT_TREE_CAPACITY,
  ExactSnapshotCheckpointValidator,
  RpcSnapshotCheckpointReader,
  SnapshotCheckpointMismatchError,
  SnapshotCheckpointUnavailableError,
  bootstrapSnapshotAtomically,
  createNodeSnapshotBootstrapCapability,
  createRpcSnapshotCheckpointValidator,
  getSnapshotBootstrapPaths,
  getWalletChainDBPath,
  recoverInterruptedSnapshotBootstrap
} from '../snapshot-bootstrap/index.js'
export type {
  AtomicSnapshotBootstrapParams,
  AtomicSnapshotBootstrapResult,
  NodeSnapshotBootstrapPaths,
  RpcSnapshotCheckpointReaderConfig,
  SnapshotBootstrapCapability,
  SnapshotBootstrapMarker,
  SnapshotBootstrapRecovery,
  SnapshotCheckpointReader,
  SnapshotCheckpointValidationInput,
  SnapshotCheckpointValidator,
  SnapshotTreeState
} from '../snapshot-bootstrap/index.js'

export {
  BlindedCommitmentType,
  CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY,
  POIListType,
  POIStatus,
  PoiNodeClient,
  PoiNodeAllUrlsFailedError,
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
  GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS,
  POIJSONRPCMethod,
  POI_NODE_CLIENT_DEFAULT_TIMEOUT_MS,
  classifyNote,
  classifyNoteSpendState,
  classifyPoi,
  getRequiredListKeys,
  isSpendableProtocol,
  toWalletBalanceBucket,
  isPOIRequired
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

export { deriveWalletKeys } from '../services/wallet/keys.js'
export type { WalletKeys } from '../services/wallet/keys.js'

export type {
  CreateWalletParams,
  WalletContext,
  WalletInfo
} from '../services/wallet/wallet-service.js'

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

export {
  InvalidEncryptionKeyError,
  InvalidMnemonicError,
  WalletAlreadyExistsError,
  WalletNotFoundError
} from '../services/wallet/errors.js'
