import type { NetworkName } from '../network-config'

class PoiNodeUrlsRequiredError extends Error {
  override readonly name = 'PoiNodeUrlsRequiredError'
  readonly network: NetworkName

  constructor (network: NetworkName) {
    super(`PPOI node URLs are required for ${network}`)
    this.network = network
  }
}

export { PoiNodeUrlsRequiredError }
