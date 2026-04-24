export { RailgunClient } from './client'
export type { RailgunClientOptions } from './client'

export { RailgunEngine } from './engine'

export type { NetworkConfig, NetworkName } from './network-config'
export { NETWORK_CONFIG } from './network-config'

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
