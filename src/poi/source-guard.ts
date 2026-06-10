import type {
  EVMBlock,
  SourceAggregator,
  SourceCoverageWindow
} from '@railgun-reloaded/scanner'

import type { NetworkName } from '../network-config'
import { NETWORK_CONFIG } from '../network-config'

import { PoiRpcSourceUnsupportedError } from './source-errors'

/**
 * Check whether a selected source window intersects the PPOI-required range.
 * @param window - Selected source coverage window.
 * @param requiredFromBlock - First requested block requiring PPOI data.
 * @param requestedEndBlock - Optional requested scan ceiling.
 * @returns True when the ranges overlap.
 */
function intersectsRequiredRange (
  window: SourceCoverageWindow,
  requiredFromBlock: bigint,
  requestedEndBlock?: bigint
): boolean {
  if (
    window.endHeight !== undefined &&
    window.endHeight < requiredFromBlock
  ) {
    return false
  }
  return requestedEndBlock === undefined ||
    window.startHeight <= requestedEndBlock
}

/**
 * Reject PPOI-required scan ranges assigned to incomplete data sources.
 * Inspection occurs before source iteration and does not mutate aggregator
 * coverage state.
 * @param params - Source validation inputs.
 * @param params.network - Network being scanned.
 * @param params.dataSource - Aggregated source selection.
 * @param params.startBlock - Inclusive scan start.
 * @param params.endBlock - Optional inclusive scan ceiling.
 */
async function assertPpoiSourceCapable (params: {
  network: NetworkName
  dataSource: SourceAggregator<EVMBlock>
  startBlock: bigint
  endBlock?: bigint
}): Promise<void> {
  const poiConfig = NETWORK_CONFIG[params.network].poi
  if (poiConfig === undefined) {
    return
  }

  const requiredFromBlock = params.startBlock > poiConfig.launchBlock
    ? params.startBlock
    : poiConfig.launchBlock
  if (
    params.endBlock !== undefined &&
    params.endBlock < requiredFromBlock
  ) {
    return
  }

  const inspectedSources = await params.dataSource.inspectSourceCoverage({
    startHeight: params.startBlock,
    ...(params.endBlock !== undefined && { endHeight: params.endBlock })
  })
  const unsupportedSources = inspectedSources.filter(source =>
    source.ppoiData === 'incomplete' &&
    intersectsRequiredRange(source, requiredFromBlock, params.endBlock)
  )

  if (unsupportedSources.length > 0) {
    throw new PoiRpcSourceUnsupportedError({
      network: params.network,
      requiredFromBlock,
      inspectedSources,
      unsupportedSources
    })
  }
}

export { assertPpoiSourceCapable }
