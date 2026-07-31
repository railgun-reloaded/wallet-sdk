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
  ShieldApprovalRevertedError,
  ShieldEventMissingError,
  ShieldFeeReadError,
  ShieldReceiptTimeoutError,
  ShieldSignatureRejectedError,
  ShieldTransactionRevertedError,
  UnexpectedShieldFieldError
} from './errors.js'
export {
  SHIELD_PRIVATE_KEY_SIGNATURE_MESSAGE,
  deriveShieldPrivateKey,
  shieldPrivateKeyFromSignature
} from './derivation.js'
export { computeShieldFee } from './fee.js'
export { parseShieldReceipt, readShieldFee } from './receipt.js'
export type {
  ShieldCommitmentPreimage,
  ShieldReceiptResult
} from './receipt.js'
export { buildShield } from './shield.js'
export type {
  BuildShieldBaseParams,
  BuildShieldErc20Params,
  BuildShieldErc721Params,
  BuildShieldParams,
  BuildShieldResult
} from './shield.js'
export type {
  ShieldApprovalMode,
  ShieldErc20Params,
  ShieldErc721Params,
  ShieldExecutionOptions,
  ShieldParams,
  ShieldResult
} from './types.js'
