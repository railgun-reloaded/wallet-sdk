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
 * Create an empty block.
 * @param number - Block height.
 * @returns Empty block.
 */
function emptyBlock (number: bigint): EVMBlock {
  return {
    number,
    hash: new Uint8Array(32),
    timestamp: 0n,
    transactions: []
  }
}

/**
 * Empty finite block source for bootstrap tests.
 */
class RangeBlockSource {
  /** Source is finite. */
  isLiveProvider = false
  /** Last requested start height. */
  observedStart: bigint | undefined
  /** Whether destroy ran. */
  destroyed = false
  /** First yieldable height. */
  readonly #from: bigint
  /** Last yieldable height. */
  readonly #to: bigint

  /**
   * Create a ranged source.
   * @param from - First yieldable height.
   * @param to - Last yieldable height.
   */
  constructor (from: bigint, to: bigint) {
    this.#from = from
    this.#to = to
  }

  /**
   * Return the source head.
   * @returns Source head.
   */
  async head () {
    return this.#to
  }

  /**
   * Yield requested empty blocks.
   * @param options - Requested range.
   * @param options.startHeight - Inclusive start.
   * @param options.endHeight - Optional inclusive end.
   * @yields Empty blocks.
   */
  async * from (options: {
    startHeight: bigint
    endHeight?: bigint | undefined
  }): AsyncGenerator<EVMBlock> {
    this.observedStart = options.startHeight
    const last = options.endHeight !== undefined && options.endHeight < this.#to
      ? options.endHeight
      : this.#to
    for (let number = options.startHeight; number <= last; number += 1n) {
      if (number < this.#from) continue
      yield emptyBlock(number)
    }
  }

  /**
   * Record destruction.
   */
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
  const source = new RangeBlockSource(START_HEIGHT, END_HEIGHT)
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

test('a zero-height sync cursor is not trusted and bootstrap proceeds', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wallet-sdk-snapshot-bootstrap-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const targetPath = getWalletChainDBPath(dataDir, NETWORK_CONFIG_ENTRY.chainID)
  mkdirSync(dirname(targetPath), { recursive: true })
  const seededDB = await createChainDB({ path: targetPath, runMigrations: true })
  await updateSyncState(seededDB, NETWORK_CONFIG_ENTRY.chainID, 0n)
  await closeChainDB(seededDB)

  const { aggregator } = snapshotSource()
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

  assert.equal(result.status, 'promoted')
  assert.equal(validated, true)

  const chainDB = await createChainDB({ path: targetPath })
  assert.equal(
    (await getSyncState(chainDB, NETWORK_CONFIG_ENTRY.chainID))?.lastBlockHeight,
    END_HEIGHT
  )
  await closeChainDB(chainDB)
})

test('Subsquid continues from endHeight + 1 after a promoted bootstrap', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wallet-sdk-snapshot-bootstrap-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))

  const { aggregator } = snapshotSource()
  const bootstrap = await bootstrapSnapshotAtomically({
    network: NETWORK,
    cid: CID,
    endHeight: END_HEIGHT,
    dataSource: aggregator,
    dataDir,
    checkpointValidator: checkpointValidator(async () => {})
  })
  assert.equal(bootstrap.status, 'promoted')

  const tail = END_HEIGHT + 5n
  const continuation = new RangeBlockSource(END_HEIGHT + 1n, tail)
  const engine = new RailgunEngine({ dataDir })
  t.after(() => engine.destroy())
  engine.setDataSource(new SourceAggregator<EVMBlock>([continuation]))
  await engine.setNetwork(NETWORK)
  await engine.scan({ endBlock: tail })

  assert.equal(continuation.observedStart, END_HEIGHT + 1n)

  const targetPath = getWalletChainDBPath(dataDir, NETWORK_CONFIG_ENTRY.chainID)
  const chainDB = await createChainDB({ path: targetPath })
  assert.equal(
    (await getSyncState(chainDB, NETWORK_CONFIG_ENTRY.chainID))?.lastBlockHeight,
    tail
  )
  await closeChainDB(chainDB)
})
