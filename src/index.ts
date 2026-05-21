export { RailgunClient } from './client'
export type {
  DecryptedNote,
  DecryptParams,
  RailgunClientOptions,
  ScanParams,
  SyncParams,
  SyncProgress,
  SyncSummary,
  TokenBalance
} from './client'

export type { DecryptSummary } from './sync/wallet-decryptor'
export { SyncPhase } from './sync/wallet-decryptor'

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
} from './events'

export { RailgunEngine } from './engine'

export type { NetworkConfig } from './network-config'
export { NETWORK_CONFIG, NetworkName } from './network-config'

export { deriveWalletKeys } from './services/wallet/keys'
export type { WalletKeys } from './services/wallet/keys'

export type {
  CreateWalletParams,
  WalletContext,
  WalletInfo
} from './services/wallet/wallet-service'

export {
  InvalidEncryptionKeyError,
  InvalidMnemonicError,
  WalletAlreadyExistsError,
  WalletNotFoundError
} from './services/wallet/errors'
