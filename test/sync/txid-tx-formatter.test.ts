import type { EVMBlock, Transact } from '@railgun-reloaded/scanner'
import {
  createChainDB,
  getRailgunTransactionByTxid,
  getRailgunTransactionsByBlockRange,
  insertRailgunTransactions
} from '@railgun-reloaded/storage'
import { test } from 'brittle'

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

test('formatRailgunTransactions formats a complete Transact fixture', (t) => {
  const [row] = formatRailgunTransactions(TEST_VECTOR_TRANSACT)
  const tx = TEST_VECTOR_TRANSACT.transactions[0]!
  const transact = tx.actions[0]![0] as Transact

  t.ok(row)
  t.is(row!.txidVersion, RailgunTransactionTxidVersion.V2)
  t.ok(bytesEqual(row!.railgunTxid, transact.txID))
  t.ok(bytesEqual(row!.chainTxid, tx.hash))
  t.is(row!.blockNumber, TEST_VECTOR_TRANSACT.number)
  t.is(row!.timestamp, TEST_VECTOR_TRANSACT.timestamp)
  t.alike(row!.nullifiers, transact.nullifiers)
  t.alike(row!.commitments, transact.commitments.map(commitment => commitment.hash))
  t.ok(bytesEqual(row!.boundParamsHash, transact.boundParamsHash))
  t.is(row!.hasUnshield, false)
  t.is(row!.unshield, null)
  t.is(row!.utxoTreeIn, transact.utxoTreeIn)
  t.is(row!.utxoTreeOut, transact.utxoTreeOut)
  t.is(row!.utxoBatchStartPositionOut, transact.utxoBatchStartPositionOut)
})

test('formatRailgunTransactions round-trips through chain.db', (t) => {
  const db = memChainDB()
  const rows = formatRailgunTransactions(TEST_VECTOR_TRANSACT)

  t.is(insertRailgunTransactions(db, rows), 1)

  const byTxid = getRailgunTransactionByTxid(db, rows[0]!.railgunTxid)
  const byBlock = getRailgunTransactionsByBlockRange(
    db,
    TEST_VECTOR_TRANSACT.number,
    TEST_VECTOR_TRANSACT.number
  )

  t.alike.coercively(byTxid, rows[0])
  t.alike.coercively(byBlock, rows)
})

test('formatRailgunTransactions includes unshield metadata', (t) => {
  const [row] = formatRailgunTransactions(TEST_VECTOR_ALL_ACTIONS)
  const transact = TEST_VECTOR_ALL_ACTIONS.transactions[0]!.actions[1]![0] as Transact

  t.ok(row)
  t.is(row!.hasUnshield, true)
  t.alike(row!.commitments, [])
  t.alike(row!.unshield, {
    to: transact.unshieldToAddress,
    token: transact.unshieldToken,
    value: transact.unshieldValue,
  })
})

test('formatRailgunTransactions skips incomplete RPC-style Transact data', (t) => {
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

  t.alike(formatRailgunTransactions(incompleteBlock), [])
})
