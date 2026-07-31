/**
 * Shield write-path module: builds unsigned shield transactions.
 *
 * Re-exported from the root, Node, and browser entries. Pulls in no Node
 * built-ins, and none of the client, chain-sync, or storage surfaces, so the
 * browser bundle check can verify this path in isolation.
 */

export {
  InvalidShieldAmountError,
  InvalidShieldPrivateKeyError,
  InvalidTokenSubIDError,
  UnexpectedShieldFieldError
} from './errors.js'
export {
  SHIELD_PRIVATE_KEY_SIGNATURE_MESSAGE,
  deriveShieldPrivateKey,
  shieldPrivateKeyFromSignature
} from './derivation.js'
export { computeShieldFee } from './fee.js'
export { shield } from './shield.js'
export type {
  ShieldBaseParams,
  ShieldErc20Params,
  ShieldErc721Params,
  ShieldParams,
  ShieldResult
} from './shield.js'
