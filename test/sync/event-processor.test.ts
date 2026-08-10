import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Transact } from '@railgun-reloaded/scanner'

import { denormalizeBlockData } from '../../src/sync/index.js'
import { TEST_VECTOR_TRANSACT } from '../test-vector.js'

/**
 * Compare two byte arrays by byte content only.
 * @param a - First byte array.
 * @param b - Second byte array.
 * @returns True when byte content matches.
 */
function bytesEqual (a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b))
}

test('denormalizeBlockData carries scanner Transact fields onto the row, with null graphID/verificationHash', () => {
  const { railgunTransactions } = denormalizeBlockData(TEST_VECTOR_TRANSACT)
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
