import type { NetworkName } from '../network-config'

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

export { PoiNodeUrlsRequiredError }
