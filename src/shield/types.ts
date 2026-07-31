import type { WalletClient } from 'viem'

import type { ShieldReceiptResult } from './receipt.js'
import type {
  BuildShieldErc20Params,
  BuildShieldErc721Params
} from './shield.js'

type ShieldApprovalMode = 'exact' | 'unlimited'

type ShieldExecutionOptions = {
  /** Viem wallet client used for signing and transaction submission. */
  signer: WalletClient
  /** Skip token approval because the caller has already managed it. */
  skipApprove?: boolean | undefined
  /** Approve only this shield or grant an unlimited/operator approval. */
  approvalMode?: ShieldApprovalMode | undefined
  /** Block confirmations required for approval and shield receipts. */
  confirmations?: number | undefined
}

type ShieldErc20Params = Omit<BuildShieldErc20Params, 'shieldPrivateKey'> &
  ShieldExecutionOptions

type ShieldErc721Params = Omit<BuildShieldErc721Params, 'shieldPrivateKey'> &
  ShieldExecutionOptions

/** Inputs for the high-level signing, approval, and submission shield path. */
type ShieldParams = ShieldErc20Params | ShieldErc721Params

/** Confirmed shield transaction and the first emitted commitment. */
type ShieldResult = ShieldReceiptResult

export type {
  ShieldApprovalMode,
  ShieldErc20Params,
  ShieldErc721Params,
  ShieldExecutionOptions,
  ShieldParams,
  ShieldResult
}
