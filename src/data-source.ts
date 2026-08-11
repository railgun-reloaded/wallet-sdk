import type { EVMBlock } from '@railgun-reloaded/scanner'
import { SourceAggregator, SubsquidProvider } from '@railgun-reloaded/scanner'

/** SDK-owned source of RAILGUN blocks from a configured indexer. */
type RailgunDataSource = SourceAggregator<EVMBlock>

/**
 * Create a sync data source backed by a Subsquid indexer.
 * @param endpointURL - Subsquid GraphQL endpoint URL.
 * @returns A data source ready for `RailgunClient.scan()` or `sync()`.
 */
function createDataSource (endpointURL: string): RailgunDataSource {
  return new SourceAggregator<EVMBlock>([
    new SubsquidProvider<EVMBlock>(endpointURL)
  ])
}

export { createDataSource }
export type { RailgunDataSource }
