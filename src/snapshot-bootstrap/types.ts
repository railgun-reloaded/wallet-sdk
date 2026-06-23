import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'

import type { NetworkName } from '../network-config.js'

const COMMITMENT_TREE_CAPACITY = 65_536

type SnapshotTreeState = {
  treeNumber: number
  leafCount: number
  root: Uint8Array
}

type SnapshotCheckpointValidationInput = {
  chainID: number
  blockHeight: bigint
  trees: SnapshotTreeState[]
}

type SnapshotCheckpointValidator = {
  validate: (input: SnapshotCheckpointValidationInput) => Promise<void>
}

type AtomicSnapshotBootstrapParams = {
  network: NetworkName
  cid: string
  endHeight: bigint
  dataSource: SourceAggregator<EVMBlock>
  checkpointValidator: SnapshotCheckpointValidator
  dataDir?: string
}

type AtomicSnapshotBootstrapResult =
  | {
    status: 'promoted'
    blockHeight: bigint
    trees: SnapshotTreeState[]
  }
  | {
    status: 'skipped'
    reason: 'trusted-state-exists'
    blockHeight: bigint
  }

export { COMMITMENT_TREE_CAPACITY }
export type {
  AtomicSnapshotBootstrapParams,
  AtomicSnapshotBootstrapResult,
  SnapshotCheckpointValidationInput,
  SnapshotCheckpointValidator,
  SnapshotTreeState
}
