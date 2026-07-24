/**
 * Contract write surface for @railgun-reloaded/wallet-sdk.
 *
 * Encodes calls to the RailgunSmartWallet V2 contract into unsigned
 * transactions. Runtime-neutral: no Node built-ins, no network access, and no
 * signing. Callers estimate gas, sign, and send with their own wallet client.
 */

export { SHIELD_ABI, SHIELD_FUNCTION_SIGNATURE } from './abi.js'
export { UnsupportedChainError, UnsupportedTokenTypeError } from './errors.js'
export { buildShieldTransaction } from './shield.js'
export type { UnsignedTx } from './shield.js'
