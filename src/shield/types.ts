import type { Hash, WalletClient } from 'viem'

import type { ShieldReceiptResult } from './receipt.js'
import type {
  BuildShieldErc20Params,
  BuildShieldErc721Params
} from './shield.js'

type ShieldApprovalMode = 'exact' | 'unlimited'

enum ShieldStage {
  /** Asking the wallet to sign the shield key derivation message. */
  DerivingKey = 'deriving-key',
  /** Reading the current ERC20 allowance or ERC721 approval. */
  CheckingApproval = 'checking-approval',
  /** Approval transaction accepted by the network, not yet confirmed. */
  ApprovalSubmitted = 'approval-submitted',
  /** Approval transaction reached the required confirmation count. */
  ApprovalConfirmed = 'approval-confirmed',
  /** Shield transaction accepted by the network, not yet confirmed. */
  ShieldSubmitted = 'shield-submitted',
  /** Shield transaction reached the required confirmation count. */
  ShieldConfirmed = 'shield-confirmed'
}

/** One stage boundary crossed by `shield()`. */
type ShieldProgress = {
  /** Stage the shield has just entered. */
  stage: ShieldStage
  /** Hash of the transaction the stage refers to, once it is known. */
  txHash?: Hash
}

type ShieldExecutionOptions = {
  /** Viem wallet client used for signing and transaction submission. */
  signer: WalletClient
  /** Skip token approval because the caller has already managed it. */
  skipApprove?: boolean | undefined
  /** Approve only this shield or grant an unlimited/operator approval. */
  approvalMode?: ShieldApprovalMode | undefined
  /** Block confirmations required for approval and shield receipts. */
  confirmations?: number | undefined
  /**
   * Fired synchronously as each shield stage begins. Exceptions thrown by the
   * callback are caught and discarded; the remaining stages still report.
   */
  onProgress?: ((progress: ShieldProgress) => void) | undefined
}

type ShieldErc20Params = Omit<BuildShieldErc20Params, 'shieldPrivateKey'> &
  ShieldExecutionOptions

type ShieldErc721Params = Omit<BuildShieldErc721Params, 'shieldPrivateKey'> &
  ShieldExecutionOptions

/** Inputs for the high-level signing, approval, and submission shield path. */
type ShieldParams = ShieldErc20Params | ShieldErc721Params

/** Confirmed shield transaction and the first emitted commitment. */
type ShieldResult = ShieldReceiptResult

export { ShieldStage }
export type {
  ShieldApprovalMode,
  ShieldErc20Params,
  ShieldErc721Params,
  ShieldExecutionOptions,
  ShieldParams,
  ShieldProgress,
  ShieldResult
}
