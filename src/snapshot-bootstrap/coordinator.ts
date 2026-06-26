// TODO(browser-support): this module imports node:fs/node:path at the top
// level and is re-exported from the package entry (src/index.ts), so any
// browser `import` of @railgun-reloaded/wallet-sdk fails at module-load time,
// not at call time. When the browser entry split lands (storage /node /browser
// pattern), move the FS-backed bootstrap behind a Node-only subpath.
import fs from 'node:fs'
import path from 'node:path'

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

import type {
  AtomicSnapshotBootstrapParams,
  AtomicSnapshotBootstrapResult,
  SnapshotTreeState
} from './types.js'

const DEFAULT_DATA_DIR = './.railgun'

/**
 * Resolve the trusted chain database path for a network.
 * @param dataDir - Wallet-sdk data directory.
 * @param chainID - Network chain ID.
 * @returns Absolute chain.db path.
 */
function getWalletChainDBPath (dataDir: string, chainID: number): string {
  return path.resolve(dataDir, 'chains', `${chainID}`, 'chain.db')
}

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

  await recoverChainBootstrap(targetPath)

  if (fs.existsSync(targetPath)) {
    const targetDB = await createChainDB({ path: targetPath, runMigrations: true })
    try {
      const trustedState = await getSyncState(targetDB, networkConfig.chainID)
      if (trustedState) {
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
  const engine = new RailgunEngine({ chainDB: stagingDB })
  let stagingClosed = false

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

    const trees = collectSnapshotTreeState(engine)
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

    await engine.destroy()
    await closeChainDB(stagingDB)
    stagingClosed = true

    try {
      promoteChainBootstrap(targetPath)
    } catch (error) {
      if (await recoverChainBootstrap(targetPath) !== 'promoted') {
        throw error
      }
    }

    return {
      status: 'promoted',
      blockHeight: params.endHeight,
      trees
    }
  } catch (error) {
    await engine.destroy()
    if (!stagingClosed) {
      await closeChainDB(stagingDB)
    }
    discardChainBootstrap(targetPath)
    throw error
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
