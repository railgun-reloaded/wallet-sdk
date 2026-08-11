/**
 * Node entry for @railgun-reloaded/wallet-sdk.
 *
 * Re-exports the portable surface, then adds what only Node can provide:
 * filesystem-backed wallet and chain database ownership, event emission, and
 * snapshot bootstrap. The explicit exports below shadow the portable ones of
 * the same name, so `RailgunClient` and `RailgunEngine` resolve to the
 * filesystem-backed implementations here.
 */

export * from '../browser/index.js'

export { RailgunClient } from '../client.js'
export type { RailgunClientOptions } from '../client.js'

export { RailgunEngine } from '../engine.js'

export type {
  BalanceUpdateEvent,
  BusErrorEvent,
  EventFilter,
  EventHandler,
  RailgunEventMap,
  SyncCompleteEvent,
  SyncErrorEvent,
  SyncPhaseTag,
  SyncProgressEvent,
  SyncStartEvent
} from '../events/index.js'

export {
  COMMITMENT_TREE_CAPACITY,
  ExactSnapshotCheckpointValidator,
  RpcSnapshotCheckpointReader,
  SnapshotCheckpointMismatchError,
  SnapshotCheckpointUnavailableError,
  bootstrapSnapshotAtomically,
  createNodeSnapshotBootstrapCapability,
  createRpcSnapshotCheckpointValidator,
  getSnapshotBootstrapPaths,
  getWalletChainDBPath,
  recoverInterruptedSnapshotBootstrap
} from '../snapshot-bootstrap/index.js'
export type {
  AtomicSnapshotBootstrapParams,
  AtomicSnapshotBootstrapResult,
  NodeSnapshotBootstrapPaths,
  RpcSnapshotCheckpointReaderConfig,
  SnapshotBootstrapCapability,
  SnapshotBootstrapMarker,
  SnapshotBootstrapRecovery,
  SnapshotCheckpointReader,
  SnapshotCheckpointValidationInput,
  SnapshotCheckpointValidator,
  SnapshotTreeState
} from '../snapshot-bootstrap/index.js'
