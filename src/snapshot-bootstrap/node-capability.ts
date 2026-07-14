import {
  discardChainBootstrap,
  prepareChainBootstrap,
  promoteChainBootstrap,
  recoverChainBootstrap
} from '@railgun-reloaded/storage/node'

import type {
  SnapshotBootstrapCapability,
  SnapshotBootstrapMarker
} from './capability.js'

type NodeSnapshotBootstrapPaths = {
  targetPath: string
  stagingPath: string
  markerPath: string
}

/**
 * Bind the runtime-neutral bootstrap capability to the Node filesystem-backed
 * chain database marker and rename implementation.
 * @param targetPath - Final chain.db path.
 * @returns Node snapshot bootstrap capability for that target.
 */
function createNodeSnapshotBootstrapCapability (
  targetPath: string
): SnapshotBootstrapCapability<NodeSnapshotBootstrapPaths> {
  return {
    /**
     * Recover any interrupted filesystem-backed bootstrap attempt.
     * @returns Recovery action.
     */
    recover: () => recoverChainBootstrap(targetPath),

    /**
     * Prepare staging files and persist the bootstrap marker.
     * @param marker - Snapshot identity and checkpoint height.
     * @returns Node staging paths.
     */
    prepare: (marker: SnapshotBootstrapMarker) =>
      prepareChainBootstrap(targetPath, marker),

    /**
     * Promote the closed staging database into the trusted target.
     * @returns Nothing.
     */
    promote: () => promoteChainBootstrap(targetPath),

    /**
     * Discard staged files and marker data.
     * @returns Nothing.
     */
    discard: () => discardChainBootstrap(targetPath)
  }
}

export { createNodeSnapshotBootstrapCapability }
export type { NodeSnapshotBootstrapPaths }
