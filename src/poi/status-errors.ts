import type { NetworkName } from '../network-config'

type PoiStatusRefreshErrorCode =
  | 'BlindedCommitmentDerivationFailed'
  | 'MissingStatusResponse'
  | 'StatusPersistenceFailed'

/**
 * Error thrown when a PPOI operation needs node URLs but none are configured.
 */
class PoiNodeUrlsRequiredError extends Error {
  /** Error class name. */
  override readonly name = 'PoiNodeUrlsRequiredError'
  /** Network missing usable PPOI node URLs. */
  readonly network: NetworkName

  /**
   * Build a missing-node-URLs error.
   * @param network - Network missing usable PPOI node URLs.
   */
  constructor (network: NetworkName) {
    super(`PPOI node URLs are required for ${network}`)
    this.network = network
  }
}

/**
 * Error produced while refreshing one or more received-note POI statuses.
 */
class PoiStatusRefreshError extends Error {
  /** Error class name. */
  override readonly name = 'PoiStatusRefreshError'
  /** Machine-readable refresh failure code. */
  readonly code: PoiStatusRefreshErrorCode
  /** Wallet containing the affected note or batch. */
  readonly walletId: string
  /** Chain containing the affected note or batch. */
  readonly chainId: number
  /** Underlying error, when one was thrown. */
  override readonly cause: unknown

  /**
   * Build a typed POI status refresh error.
   * @param params - Refresh failure details.
   * @param params.code - Machine-readable failure code.
   * @param params.walletId - Wallet containing the affected note or batch.
   * @param params.chainId - Chain containing the affected note or batch.
   * @param params.message - Human-readable failure message.
   * @param params.cause - Optional underlying thrown value.
   */
  constructor (params: {
    code: PoiStatusRefreshErrorCode
    walletId: string
    chainId: number
    message: string
    cause?: unknown
  }) {
    super(params.message)
    this.code = params.code
    this.walletId = params.walletId
    this.chainId = params.chainId
    this.cause = params.cause
  }
}

export { PoiNodeUrlsRequiredError, PoiStatusRefreshError }
export type { PoiStatusRefreshErrorCode }
