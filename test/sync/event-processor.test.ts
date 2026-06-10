import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  DataSource,
  EVMBlock,
  PpoiDataSourceCapability,
  SyncOptions,
  Transact
} from '@railgun-reloaded/scanner'
import { SourceAggregator } from '@railgun-reloaded/scanner'
import {
  createChainDB,
  getRailgunTransactionByTxid,
  getRailgunTransactionsByBlockRange,
  getSyncState,
  getTxidSyncCursor
} from '@railgun-reloaded/storage'

import { RailgunEngine } from '../../src/engine'
import { NetworkName } from '../../src/network-config'
import { denormalizeBlockData } from '../../src/sync'
import { TEST_VECTOR_TRANSACT } from '../test-vector'

const SEPOLIA_CHAIN_ID = 11155111

/**
 * Compare two byte arrays by byte content only.
 * @param a - First byte array.
 * @param b - Second byte array.
 * @returns True when byte content matches.
 */
function bytesEqual (a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b))
}

test('denormalizeBlockData yields one railgun-tx row per ppoi-complete Transact', () => {
  const { railgunTransactions } = denormalizeBlockData(TEST_VECTOR_TRANSACT, {
    sourceCapability: 'complete'
  })
  assert.equal(railgunTransactions.length, 1)
})

test('denormalizeBlockData carries scanner Transact fields onto the row, with null graphID/verificationHash', () => {
  const { railgunTransactions } = denormalizeBlockData(TEST_VECTOR_TRANSACT, {
    sourceCapability: 'complete'
  })
  const row = railgunTransactions[0]!
  const tx = TEST_VECTOR_TRANSACT.transactions[0]!
  const transact = tx.actions[0]![0] as Transact

  assert.ok(bytesEqual(row.railgunTxid, transact.txID))
  assert.ok(bytesEqual(row.chainTxid, tx.hash))
  assert.equal(row.blockNumber, TEST_VECTOR_TRANSACT.number)
  assert.equal(row.timestamp, TEST_VECTOR_TRANSACT.timestamp)
  assert.deepEqual(row.nullifiers, transact.nullifiers)
  assert.ok(bytesEqual(row.boundParamsHash, transact.boundParamsHash))
  assert.equal(row.hasUnshield, false)
  assert.equal(row.unshield, null)
  assert.equal(row.utxoTreeIn, transact.utxoTreeIn)
  assert.equal(row.utxoTreeOut, transact.utxoTreeOut)
  assert.equal(row.utxoBatchStartPositionOut, transact.utxoBatchStartPositionOut)
  assert.equal(row.graphID, null)
  assert.equal(row.verificationHash, null)
})

test('denormalizeBlockData does not infer PPOI completeness from full-width fields', () => {
  const { railgunTransactions } = denormalizeBlockData(TEST_VECTOR_TRANSACT, {
    sourceCapability: 'incomplete'
  })
  assert.deepEqual(railgunTransactions, [])
})

/**
 * Finite source fake with an explicit PPOI capability.
 */
class CursorSource implements DataSource<EVMBlock> {
  /** This source is finite. */
  readonly isLiveProvider = false
  /** PPOI guarantee exposed to the aggregator. */
  readonly capabilities: {
    ppoiData: PpoiDataSourceCapability
  }

  /**
   * Create a cursor-test source.
   * @param headHeight - Finite source head.
   * @param blocks - Event-bearing blocks to yield.
   * @param ppoiData - PPOI source guarantee.
   */
  constructor (
    private readonly headHeight: bigint,
    private readonly blocks: EVMBlock[],
    ppoiData: PpoiDataSourceCapability
  ) {
    this.capabilities = { ppoiData }
  }

  /**
   * Return the finite source head.
   * @returns Source head.
   */
  async head (): Promise<bigint> {
    return this.headHeight
  }

  /**
   * Yield event blocks in the requested range.
   * @param options - Requested sync range.
   * @returns Block generator.
   * @yields Matching blocks.
   */
  async * from (options: SyncOptions): AsyncGenerator<EVMBlock> {
    for (const block of this.blocks) {
      if (block.number < options.startHeight) continue
      if (options.endHeight !== undefined && block.number > options.endHeight) break
      yield block
    }
  }

  /** Release source resources. */
  destroy (): void {}
}

/**
 * Build a Transact-only block without commitment or nullifier side effects.
 * @param number - Block height.
 * @returns PPOI-complete block fixture.
 */
function txidOnlyBlock (number: bigint): EVMBlock {
  const transaction = TEST_VECTOR_TRANSACT.transactions[0]!
  const transact = transaction.actions[0]![0] as Transact
  return {
    ...TEST_VECTOR_TRANSACT,
    number,
    transactions: [{
      ...transaction,
      actions: [[{
        ...transact,
        nullifiers: [],
        commitments: []
      }]]
    }]
  }
}

/**
 * Create an in-memory chain database.
 * @returns Migrated chain database.
 */
function memChainDB () {
  return createChainDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/chain'
  })
}

/**
 * Configure an engine for a source.
 * @param source - Source to aggregate.
 * @param chainDB - Injected chain database.
 * @returns Configured engine.
 */
function cursorEngine (
  source: DataSource<EVMBlock>,
  chainDB: ReturnType<typeof memChainDB>
): RailgunEngine {
  const engine = new RailgunEngine({ chainDB })
  engine.setLogger(() => {})
  engine.setNetwork(NetworkName.EthereumSepolia)
  engine.setDataSource(new SourceAggregator([source]))
  return engine
}

test('TXID cursor advances with rows from a PPOI-complete source', async () => {
  const chainDB = memChainDB()
  const block = txidOnlyBlock(TEST_VECTOR_TRANSACT.number)
  const engine = cursorEngine(
    new CursorSource(block.number, [block], 'complete'),
    chainDB
  )

  await engine.scan({ endBlock: block.number })

  assert.equal(getTxidSyncCursor(chainDB, SEPOLIA_CHAIN_ID), block.number)
  assert.equal(
    getRailgunTransactionsByBlockRange(chainDB, block.number, block.number).length,
    1
  )
})

test('duplicate-only PPOI windows advance the cursor without mutating the canonical row', async () => {
  const chainDB = memChainDB()
  const firstBlock = txidOnlyBlock(TEST_VECTOR_TRANSACT.number)
  const secondBlock = txidOnlyBlock(firstBlock.number + 1n)
  const engine = cursorEngine(
    new CursorSource(firstBlock.number, [firstBlock], 'complete'),
    chainDB
  )

  await engine.scan({ endBlock: firstBlock.number })
  const original = getRailgunTransactionsByBlockRange(
    chainDB,
    firstBlock.number,
    firstBlock.number
  )[0]!

  engine.setDataSource(new SourceAggregator([
    new CursorSource(secondBlock.number, [secondBlock], 'complete')
  ]))
  await engine.scan({ endBlock: secondBlock.number })

  assert.equal(getTxidSyncCursor(chainDB, SEPOLIA_CHAIN_ID), secondBlock.number)
  assert.deepEqual(
    getRailgunTransactionByTxid(chainDB, original.railgunTxid),
    original
  )
})

test('successful empty PPOI-complete windows advance both independent cursors', async () => {
  const chainDB = memChainDB()
  const head = TEST_VECTOR_TRANSACT.number
  const engine = cursorEngine(
    new CursorSource(head, [], 'complete'),
    chainDB
  )

  await engine.scan({ endBlock: head })

  assert.equal(getSyncState(chainDB, SEPOLIA_CHAIN_ID)?.lastBlockHeight, head)
  assert.equal(getTxidSyncCursor(chainDB, SEPOLIA_CHAIN_ID), head)
})

test('PPOI-incomplete sources advance commitment sync without advancing TXID state', async () => {
  const chainDB = memChainDB()
  const block = txidOnlyBlock(TEST_VECTOR_TRANSACT.number)
  const engine = cursorEngine(
    new CursorSource(block.number, [block], 'incomplete'),
    chainDB
  )

  await engine.scan({ endBlock: block.number })

  assert.equal(getSyncState(chainDB, SEPOLIA_CHAIN_ID)?.lastBlockHeight, block.number)
  assert.equal(getTxidSyncCursor(chainDB, SEPOLIA_CHAIN_ID), 0n)
  assert.deepEqual(
    getRailgunTransactionsByBlockRange(chainDB, block.number, block.number),
    []
  )
})

test('commitment-only sync cannot advance TXID state', async () => {
  const chainDB = memChainDB()
  const block = txidOnlyBlock(TEST_VECTOR_TRANSACT.number)
  const engine = cursorEngine(
    new CursorSource(block.number, [block], 'complete'),
    chainDB
  )

  await engine.scan({
    endBlock: block.number,
    persistRailgunTransactions: false
  })

  assert.equal(getSyncState(chainDB, SEPOLIA_CHAIN_ID)?.lastBlockHeight, block.number)
  assert.equal(getTxidSyncCursor(chainDB, SEPOLIA_CHAIN_ID), 0n)
})

test('a later complete source cannot advance TXID state across an earlier gap', async () => {
  const chainDB = memChainDB()
  const firstBlock = txidOnlyBlock(TEST_VECTOR_TRANSACT.number)
  const secondBlock = txidOnlyBlock(firstBlock.number + 1n)
  const engine = cursorEngine(
    new CursorSource(firstBlock.number, [firstBlock], 'complete'),
    chainDB
  )

  await engine.scan({
    endBlock: firstBlock.number,
    persistRailgunTransactions: false
  })
  engine.setDataSource(new SourceAggregator([
    new CursorSource(secondBlock.number, [secondBlock], 'complete')
  ]))
  await engine.scan({ endBlock: secondBlock.number })

  assert.equal(getTxidSyncCursor(chainDB, SEPOLIA_CHAIN_ID), 0n)
  assert.deepEqual(
    getRailgunTransactionsByBlockRange(
      chainDB,
      firstBlock.number,
      secondBlock.number
    ),
    []
  )
})

test('TXID persistence failure leaves both cursors unchanged', async () => {
  const chainDB = memChainDB()
  const block = txidOnlyBlock(TEST_VECTOR_TRANSACT.number)
  const engine = cursorEngine(
    new CursorSource(block.number, [block], 'complete'),
    chainDB
  )
  chainDB.$client.exec(`
    CREATE TRIGGER fail_railgun_transaction_insert
    BEFORE INSERT ON railgun_transactions
    BEGIN
      SELECT RAISE(ABORT, 'forced TXID persistence failure');
    END
  `)

  await assert.rejects(
    engine.scan({ endBlock: block.number }),
    /forced TXID persistence failure/
  )

  assert.equal(getSyncState(chainDB, SEPOLIA_CHAIN_ID), undefined)
  assert.equal(getTxidSyncCursor(chainDB, SEPOLIA_CHAIN_ID), 0n)
})
