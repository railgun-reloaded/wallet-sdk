/**
 * RAILGUN Reloaded Wallet SDK
 *
 * Main exports for the wallet SDK package.
 */

// High-level wallet API
export { RailgunWalletSDK } from './wallet'
export type { DecryptedNote, TokenBalance } from './wallet'

// Infrastructure engine
export { RailgunEngine } from './engine'

// Network configuration
export type { NetworkName, NetworkConfig } from './network-config'
export { NETWORK_CONFIG } from './network-config'
