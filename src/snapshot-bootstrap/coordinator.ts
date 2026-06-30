// TODO(browser-support): this module imports node:fs/node:path at the top
// level and is re-exported from the package entry (src/index.ts), so any
// browser `import` of @railgun-reloaded/wallet-sdk fails at module-load time,
// not at call time. When the browser entry split lands (storage /node /browser
// pattern), move the FS-backed bootstrap behind a Node-only subpath.
import fs from 'node:fs'

import {
  closeChainDB,
  createChainDB,
  discardChainBootstrap,
  getChainBootstrapPaths,
  getSyncState,
  prepareChainBootstrap,
  promoteChainBootstrap,
  recordSnapshotCheckpoint,
  recoverChainBootstrap
} from '@railgun-reloaded/storage/node'

import { RailgunEngine } from '../engine.js'
import { NoteCommitmentTree } from '../merkle/index.js'
import { NETWORK_CONFIG } from '../network-config.js'

import { getWalletChainDBPath } from './paths.js'
import type {
  AtomicSnapshotBootstrapParams,
  AtomicSnapshotBootstrapResult,
  SnapshotTreeState
} from './types.js'

const DEFAULT_DATA_DIR = './.railgun'

/**
 * Remove or finalize files left by an interrupted bootstrap attempt.
 * @param dataDir - Wallet-sdk data directory.
 * @param chainID - Network chain ID.
 * @returns Recovery action.
 */
function recoverInterruptedSnapshotBootstrap (
  dataDir: string,
  chainID: number
) {
  return recoverChainBootstrap(getWalletChainDBPath(dataDir, chainID))
}

/**
 * Collect the exact local commitment-tree state to present to a validator.
 * @param engine - Engine that ingested the staged snapshot.
 * @returns Contiguous tree state ordered by tree number.
 */
function collectSnapshotTreeState (engine: RailgunEngine): SnapshotTreeState[] {
  const trees = [...engine.getAllNoteCommitmentTree()]
    .sort(([left], [right]) => left - right)
    .map(([treeNumber, tree]) => ({
      treeNumber,
      leafCount: tree.merkleTree.length,
      root: Uint8Array.from(tree.root())
    }))

  if (trees.length > 0) {
    return trees
  }

  const emptyTree = new NoteCommitmentTree()
  return [{
    treeNumber: 0,
    leafCount: 0,
    root: Uint8Array.from(emptyTree.root())
  }]
}

/**
 * Build snapshot state in a disposable chain database, validate its exact
 * checkpoint, then atomically rename it into the trusted chain.db location.
 * Existing trusted sync state makes bootstrap ineligible and is never changed.
 * @param params - Snapshot source, identity, network, and validator.
 * @returns Promotion or skip result.
 */
async function bootstrapSnapshotAtomically (
  params: AtomicSnapshotBootstrapParams
): Promise<AtomicSnapshotBootstrapResult> {
  const dataDir = params.dataDir ?? DEFAULT_DATA_DIR
  const networkConfig = NETWORK_CONFIG[params.network]
  const targetPath = getWalletChainDBPath(dataDir, networkConfig.chainID)

  if (fs.existsSync(targetPath)) {
    const targetDB = await createChainDB({ path: targetPath, runMigrations: false })
    try {
      const trustedState = await getSyncState(targetDB, networkConfig.chainID)
      if (trustedState && trustedState.lastBlockHeight > 0n) {
        params.dataSource.destroy()
        return {
          status: 'skipped',
          reason: 'trusted-state-exists',
          blockHeight: trustedState.lastBlockHeight
        }
      }
    } finally {
      await closeChainDB(targetDB)
    }
  }

  const paths = await prepareChainBootstrap(targetPath, {
    chainID: networkConfig.chainID,
    cid: params.cid,
    blockHeight: params.endHeight
  })

  let stagingDB
  try {
    stagingDB = await createChainDB({
      path: paths.stagingPath,
      runMigrations: true
    })
  } catch (error) {
    params.dataSource.destroy()
    discardChainBootstrap(targetPath)
    throw error
  }

  // The staging DB must be closed before the file is promoted.
  let trees: SnapshotTreeState[]
  const engine = new RailgunEngine({ chainDB: stagingDB })
  try {
    engine.setDataSource(params.dataSource)
    await engine.setNetwork(params.network)
    const coveredThrough = await engine.scan({ endBlock: params.endHeight })
    if (coveredThrough !== params.endHeight) {
      throw new Error(
        `Snapshot bootstrap covered ${coveredThrough ?? 'no blocks'}, ` +
        `expected ${params.endHeight}`
      )
    }

    trees = collectSnapshotTreeState(engine)
    await params.checkpointValidator.validate({
      chainID: networkConfig.chainID,
      blockHeight: params.endHeight,
      trees
    })
    await recordSnapshotCheckpoint(stagingDB, {
      chainID: networkConfig.chainID,
      cid: params.cid,
      blockHeight: params.endHeight,
      trees
    })
  } catch (error) {
    discardChainBootstrap(targetPath)
    throw error
  } finally {
    await engine.destroy()
    await closeChainDB(stagingDB)
  }

  try {
    promoteChainBootstrap(targetPath)
  } catch (error) {
    if (await recoverChainBootstrap(targetPath) !== 'promoted') {
      discardChainBootstrap(targetPath)
      throw error
    }
  }

  return {
    status: 'promoted',
    blockHeight: params.endHeight,
    trees
  }
}

/**
 * Expose deterministic bootstrap paths for diagnostics and tests.
 * @param dataDir - Wallet-sdk data directory.
 * @param chainID - Network chain ID.
 * @returns Trusted, staged, and marker paths.
 */
function getSnapshotBootstrapPaths (dataDir: string, chainID: number) {
  return getChainBootstrapPaths(getWalletChainDBPath(dataDir, chainID))
}

export {
  bootstrapSnapshotAtomically,
  getSnapshotBootstrapPaths,
  getWalletChainDBPath,
  recoverInterruptedSnapshotBootstrap
}
