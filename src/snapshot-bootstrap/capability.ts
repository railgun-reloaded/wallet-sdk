/**
 * Result of recovering a staged snapshot bootstrap attempt.
 */
type SnapshotBootstrapRecovery = 'none' | 'discarded' | 'promoted'

/**
 * Runtime-neutral snapshot identity and exact checkpoint height.
 */
type SnapshotBootstrapMarker = {
  chainID: number
  cid: string
  blockHeight: bigint
}

/**
 * Minimal capability required to run atomic snapshot bootstrap.
 *
 * The portable client depends only on these operations. Runtime-specific
 * implementations decide how staging, marker persistence, promotion, and
 * cleanup are represented.
 */
type SnapshotBootstrapCapability<TPrepared> = {
  recover: () => Promise<SnapshotBootstrapRecovery>
  prepare: (marker: SnapshotBootstrapMarker) => Promise<TPrepared>
  promote: () => void
  discard: () => void
}

export type {
  SnapshotBootstrapCapability,
  SnapshotBootstrapMarker,
  SnapshotBootstrapRecovery
}
