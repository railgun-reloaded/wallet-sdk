import type { SourceCoverageWindow } from '@railgun-reloaded/scanner'

import type { NetworkName } from '../network-config'

/**
 * Error thrown when a selected scan window cannot provide the complete
 * transaction fields required for PPOI/TXID persistence.
 */
class PoiRpcSourceUnsupportedError extends Error {
  /** Error class name. */
  override readonly name = 'PoiRpcSourceUnsupportedError'
  /** PPOI-enabled network that rejected the source selection. */
  readonly network: NetworkName
  /** First block in the requested range that requires PPOI data. */
  readonly requiredFromBlock: bigint
  /** Source windows inspected before iteration began. */
  readonly inspectedSources: SourceCoverageWindow[]
  /** PPOI-incomplete windows intersecting the required range. */
  readonly unsupportedSources: SourceCoverageWindow[]

  /**
   * Build a typed unsupported-source error.
   * @param params - Source validation failure details.
   * @param params.network - PPOI-enabled network being scanned.
   * @param params.requiredFromBlock - First requested PPOI-required block.
   * @param params.inspectedSources - Source windows selected for the scan.
   * @param params.unsupportedSources - Incomplete selected windows.
   */
  constructor (params: {
    network: NetworkName
    requiredFromBlock: bigint
    inspectedSources: SourceCoverageWindow[]
    unsupportedSources: SourceCoverageWindow[]
  }) {
    const unsupportedIndexes = params.unsupportedSources
      .map(source => source.sourceIndex)
      .join(', ')
    super(
      `PPOI-complete source data is required for ${params.network} from block ` +
      `${params.requiredFromBlock}; unsupported source indexes: ` +
      `${unsupportedIndexes || '(none)'}`
    )
    this.network = params.network
    this.requiredFromBlock = params.requiredFromBlock
    this.inspectedSources = params.inspectedSources.map(source => ({ ...source }))
    this.unsupportedSources = params.unsupportedSources.map(source => ({ ...source }))
  }
}

export { PoiRpcSourceUnsupportedError }
