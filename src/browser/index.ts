/**
 * Browser-safe entry for @railgun-reloaded/wallet-sdk.
 *
 * Exposes a portable `RailgunClient`/`RailgunEngine` that never import Node
 * built-ins: chain and wallet storage contracts are injected by the caller
 * (for example from `@railgun-reloaded/storage/browser`) and remain
 * caller-owned. The Node entry (`@railgun-reloaded/wallet-sdk/node`) keeps
 * its filesystem-backed behavior.
 *
 * TODO: the events API (`EventBus`, event filters, `client.on()`) is
 * Node-only today and deliberately absent here. Port it to this entry before
 * wallets build UIs on event subscriptions.
 */

export { RailgunClient } from './client.js'
export type {
  DecryptParams,
  RailgunClientOptions,
  ScanParams,
  SyncParams,
  SyncSummary
} from './client.js'
export { RailgunEngine } from './engine.js'

export type {
  BalanceMode,
  DecryptedNote,
  TokenBalance
} from '../services/balance/balance-service.js'

export type { DecryptSummary, SyncProgress } from '../sync/wallet-decryptor.js'
export { SyncPhase } from '../sync/wallet-decryptor.js'

export { initializeCrypto } from '../init/crypto.js'

export type { NetworkConfig } from '../network-config.js'
export { NETWORK_CONFIG, NetworkName } from '../network-config.js'

export { deriveWalletKeys } from '../services/wallet/keys.js'
export type { WalletKeys } from '../services/wallet/keys.js'

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

export type { RefreshSummary } from '../poi/index.js'
export {
  POIStatus,
  PoiNodeUrlsRequiredError,
  WalletBalanceBucket
} from '../poi/index.js'
