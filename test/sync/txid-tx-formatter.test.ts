import type { EVMBlock, Transact } from '@railgun-reloaded/scanner'
import {
  createChainDB,
  getRailgunTransactionByTxid,
  getRailgunTransactionsByBlockRange,
  insertRailgunTransactions
} from '@railgun-reloaded/storage'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  formatRailgunTransactions,
  RailgunTransactionTxidVersion
} from '../../src/sync'

import { TEST_VECTOR_ALL_ACTIONS, TEST_VECTOR_TRANSACT } from '../test-vector'

/**
 * Build a fresh in-memory chain DB for formatter round-trip tests.
 * @returns ChainDB with migrations applied.
 */
function memChainDB () {
  return createChainDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/chain'
  })
}

/**
 * Compare two byte arrays by byte content only.
 * @param a - First byte array.
 * @param b - Second byte array.
 * @returns True when byte content matches.
 */
function bytesEqual (a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b))
}

function normalizeByteValues (value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex')
  }
  if (Array.isArray(value)) {
    return value.map(normalizeByteValues)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeByteValues(entry)])
    )
  }
  return value
}

test('formatRailgunTransactions formats a complete Transact fixture', () => {
  const [row] = formatRailgunTransactions(TEST_VECTOR_TRANSACT)
  const tx = TEST_VECTOR_TRANSACT.transactions[0]!
  const transact = tx.actions[0]![0] as Transact

  assert.ok(row)
  assert.equal(row!.txidVersion, RailgunTransactionTxidVersion.V2)
  assert.ok(bytesEqual(row!.railgunTxid, transact.txID))
  assert.ok(bytesEqual(row!.chainTxid, tx.hash))
  assert.equal(row!.blockNumber, TEST_VECTOR_TRANSACT.number)
  assert.equal(row!.timestamp, TEST_VECTOR_TRANSACT.timestamp)
  assert.deepEqual(row!.nullifiers, transact.nullifiers)
  assert.deepEqual(row!.commitments, transact.commitments.map(commitment => commitment.hash))
  assert.ok(bytesEqual(row!.boundParamsHash, transact.boundParamsHash))
  assert.equal(row!.hasUnshield, false)
  assert.equal(row!.unshield, null)
  assert.equal(row!.utxoTreeIn, transact.utxoTreeIn)
  assert.equal(row!.utxoTreeOut, transact.utxoTreeOut)
  assert.equal(row!.utxoBatchStartPositionOut, transact.utxoBatchStartPositionOut)
})

test('formatRailgunTransactions round-trips through chain.db', () => {
  const db = memChainDB()
  const rows = formatRailgunTransactions(TEST_VECTOR_TRANSACT)

  assert.equal(insertRailgunTransactions(db, rows), 1)

  const byTxid = getRailgunTransactionByTxid(db, rows[0]!.railgunTxid)
  const byBlock = getRailgunTransactionsByBlockRange(
    db,
    TEST_VECTOR_TRANSACT.number,
    TEST_VECTOR_TRANSACT.number
  )

  assert.deepEqual(normalizeByteValues(byTxid), normalizeByteValues(rows[0]))
  assert.deepEqual(normalizeByteValues(byBlock), normalizeByteValues(rows))
})

test('formatRailgunTransactions includes unshield metadata', () => {
  const [row] = formatRailgunTransactions(TEST_VECTOR_ALL_ACTIONS)
  const transact = TEST_VECTOR_ALL_ACTIONS.transactions[0]!.actions[1]![0] as Transact

  assert.ok(row)
  assert.equal(row!.hasUnshield, true)
  assert.deepEqual(row!.commitments, [])
  assert.deepEqual(row!.unshield, {
    to: transact.unshieldToAddress,
    token: transact.unshieldToken,
    value: transact.unshieldValue,
  })
})

test('formatRailgunTransactions skips incomplete RPC-style Transact data', () => {
  const tx = TEST_VECTOR_TRANSACT.transactions[0]!
  const transact = tx.actions[0]![0] as Transact
  const incompleteBlock: EVMBlock = {
    ...TEST_VECTOR_TRANSACT,
    transactions: [{
      ...tx,
      actions: [[{
        ...transact,
        boundParamsHash: new Uint8Array([0]),
      }]],
    }],
  }

  assert.deepEqual(formatRailgunTransactions(incompleteBlock), [])
})
