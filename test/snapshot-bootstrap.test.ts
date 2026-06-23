import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import type { EVMBlock } from '@railgun-reloaded/scanner'
import { SourceAggregator } from '@railgun-reloaded/scanner'
import {
  closeChainDB,
  createChainDB,
  getSnapshotCheckpoint,
  getSyncState,
  prepareChainBootstrap,
  updateSyncState
} from '@railgun-reloaded/storage/node'

import { RailgunEngine } from '../src/engine.js'
import { NETWORK_CONFIG, NetworkName } from '../src/network-config.js'
import {
  bootstrapSnapshotAtomically,
  getSnapshotBootstrapPaths,
  getWalletChainDBPath
} from '../src/snapshot-bootstrap/coordinator.js'
import type {
  SnapshotCheckpointValidationInput,
  SnapshotCheckpointValidator
} from '../src/snapshot-bootstrap/types.js'

const NETWORK = NetworkName.EthereumSepolia
const NETWORK_CONFIG_ENTRY = NETWORK_CONFIG[NETWORK]
const START_HEIGHT = NETWORK_CONFIG_ENTRY.deploymentBlock
const END_HEIGHT = START_HEIGHT + 1n
const CID = 'bafyreivalidatedsnapshot'

/**
 * Finite source that yields empty event blocks across the snapshot range.
 */
class EmptyBlockSource {
  /** Snapshot sources are finite. */
  isLiveProvider = false
  /** Whether the aggregator released this source. */
  destroyed = false

  /**
   * Return the configured snapshot end.
   * @returns Snapshot end height.
   */
  async head () {
    return END_HEIGHT
  }

  /**
   * Yield empty blocks in the requested snapshot range.
   * @param options - Requested range.
   * @param options.startHeight - Inclusive start.
   * @param options.endHeight - Optional inclusive end.
   * @yields Empty EVM blocks.
   */
  async * from (options: {
    startHeight: bigint
    endHeight?: bigint | undefined
  }): AsyncGenerator<EVMBlock> {
    for (const number of [START_HEIGHT, END_HEIGHT]) {
      if (number < options.startHeight) continue
      if (options.endHeight !== undefined && number > options.endHeight) continue
      yield {
        number,
        hash: new Uint8Array(32),
        timestamp: 0n,
        transactions: []
      }
    }
  }

  /** Record source destruction. */
  destroy () {
    this.destroyed = true
  }
}

/**
 * Wrap a validation callback in the checkpoint-validator interface.
 * @param validate - Validation callback.
 * @returns Checkpoint validator.
 */
function checkpointValidator (
  validate: SnapshotCheckpointValidator['validate']
): SnapshotCheckpointValidator {
  return { validate }
}

/**
 * Create an aggregator whose source exposes destruction for assertions.
 * @returns Source and aggregator.
 */
function snapshotSource () {
  const source = new EmptyBlockSource()
  return {
    source,
    aggregator: new SourceAggregator<EVMBlock>([source])
  }
}

test('valid snapshot state is validated then atomically promoted', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wallet-sdk-snapshot-bootstrap-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const { source, aggregator } = snapshotSource()
  let validation: SnapshotCheckpointValidationInput | undefined

  const result = await bootstrapSnapshotAtomically({
    network: NETWORK,
    cid: CID,
    endHeight: END_HEIGHT,
    dataSource: aggregator,
    dataDir,
    checkpointValidator: checkpointValidator(async input => {
      validation = input
    })
  })

  assert.equal(result.status, 'promoted')
  assert.equal(source.destroyed, true)
  assert.equal(validation?.chainID, NETWORK_CONFIG_ENTRY.chainID)
  assert.equal(validation?.blockHeight, END_HEIGHT)
  assert.equal(validation?.trees.length, 1)

  const paths = getSnapshotBootstrapPaths(dataDir, NETWORK_CONFIG_ENTRY.chainID)
  assert.equal(existsSync(paths.targetPath), true)
  assert.equal(existsSync(paths.stagingPath), false)
  assert.equal(existsSync(paths.markerPath), false)

  const chainDB = await createChainDB({ path: paths.targetPath })
  const syncState = await getSyncState(chainDB, NETWORK_CONFIG_ENTRY.chainID)
  const checkpoint = await getSnapshotCheckpoint(
    chainDB,
    NETWORK_CONFIG_ENTRY.chainID
  )
  await closeChainDB(chainDB)
  assert.equal(syncState?.lastBlockHeight, END_HEIGHT)
  assert.equal(checkpoint?.cid, CID)
  assert.equal(checkpoint?.blockHeight, END_HEIGHT)
})

test('validation failure discards every staged bootstrap file', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wallet-sdk-snapshot-bootstrap-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const { source, aggregator } = snapshotSource()

  await assert.rejects(
    () => bootstrapSnapshotAtomically({
      network: NETWORK,
      cid: CID,
      endHeight: END_HEIGHT,
      dataSource: aggregator,
      dataDir,
      checkpointValidator: checkpointValidator(async () => {
        throw new Error('checkpoint mismatch')
      })
    }),
    /checkpoint mismatch/
  )

  const paths = getSnapshotBootstrapPaths(dataDir, NETWORK_CONFIG_ENTRY.chainID)
  assert.equal(source.destroyed, true)
  assert.equal(existsSync(paths.targetPath), false)
  assert.equal(existsSync(paths.stagingPath), false)
  assert.equal(existsSync(paths.markerPath), false)
})

test('existing trusted state skips snapshot bootstrap without validation', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wallet-sdk-snapshot-bootstrap-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const targetPath = getWalletChainDBPath(dataDir, NETWORK_CONFIG_ENTRY.chainID)
  mkdirSync(dirname(targetPath), { recursive: true })
  const trustedDB = await createChainDB({
    path: targetPath,
    runMigrations: true
  })
  await updateSyncState(trustedDB, NETWORK_CONFIG_ENTRY.chainID, START_HEIGHT)
  await closeChainDB(trustedDB)

  const { source, aggregator } = snapshotSource()
  let validated = false
  const result = await bootstrapSnapshotAtomically({
    network: NETWORK,
    cid: CID,
    endHeight: END_HEIGHT,
    dataSource: aggregator,
    dataDir,
    checkpointValidator: checkpointValidator(async () => {
      validated = true
    })
  })

  assert.deepEqual(result, {
    status: 'skipped',
    reason: 'trusted-state-exists',
    blockHeight: START_HEIGHT
  })
  assert.equal(validated, false)
  assert.equal(source.destroyed, true)

  const unchangedDB = await createChainDB({ path: targetPath })
  assert.equal(
    (await getSyncState(unchangedDB, NETWORK_CONFIG_ENTRY.chainID))
      ?.lastBlockHeight,
    START_HEIGHT
  )
  await closeChainDB(unchangedDB)
})

test('normal engine scan discards an interrupted bootstrap before opening chain.db', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wallet-sdk-snapshot-bootstrap-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const targetPath = getWalletChainDBPath(dataDir, NETWORK_CONFIG_ENTRY.chainID)
  const paths = await prepareChainBootstrap(targetPath, {
    chainID: NETWORK_CONFIG_ENTRY.chainID,
    cid: CID,
    blockHeight: END_HEIGHT
  })
  const interruptedDB = await createChainDB({
    path: paths.stagingPath,
    runMigrations: true
  })
  await updateSyncState(
    interruptedDB,
    NETWORK_CONFIG_ENTRY.chainID,
    END_HEIGHT
  )
  await closeChainDB(interruptedDB)

  const { aggregator } = snapshotSource()
  const engine = new RailgunEngine({ dataDir })
  t.after(() => engine.destroy())
  engine.setDataSource(aggregator)
  await engine.setNetwork(NETWORK)
  await engine.scan({ endBlock: END_HEIGHT })

  assert.equal(existsSync(paths.markerPath), false)
  assert.equal(existsSync(paths.stagingPath), false)
  assert.equal(existsSync(paths.targetPath), true)

  const trustedDB = await createChainDB({ path: paths.targetPath })
  assert.equal(
    (await getSyncState(trustedDB, NETWORK_CONFIG_ENTRY.chainID))
      ?.lastBlockHeight,
    END_HEIGHT
  )
  assert.equal(
    await getSnapshotCheckpoint(trustedDB, NETWORK_CONFIG_ENTRY.chainID),
    undefined
  )
  await closeChainDB(trustedDB)
})
