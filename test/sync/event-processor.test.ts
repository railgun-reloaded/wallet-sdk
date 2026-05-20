import {
  createChainDB,
  getRailgunTransactionsByBlockRange,
  getSyncState,
  getTxidSyncCursor,
  insertRailgunTransactions,
  setTxidSyncCursor,
  updateSyncState
} from '@railgun-reloaded/storage'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { denormalizeBlockData } from '../../src/sync'
import { NETWORK_CONFIG, NetworkName } from '../../src/network-config'

import { TEST_VECTOR_TRANSACT } from '../test-vector'

/**
 * Build a fresh in-memory chain DB for event-processor tests.
 * @returns ChainDB with migrations applied.
 */
function memChainDB () {
  return createChainDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/chain'
  })
}

test('event processor exposes Railgun TXID rows without advancing cursor by itself', () => {
  const chainDB = memChainDB()
  const chainID = NETWORK_CONFIG[NetworkName.EthereumSepolia].chainID
  const { railgunTransactions } = denormalizeBlockData(TEST_VECTOR_TRANSACT)

  assert.equal(railgunTransactions.length, 1)

  updateSyncState(chainDB, chainID, TEST_VECTOR_TRANSACT.number)

  assert.equal(getSyncState(chainDB, chainID)?.lastBlockHeight, TEST_VECTOR_TRANSACT.number)
  assert.equal(getTxidSyncCursor(chainDB, chainID), 0n)
  assert.deepEqual(getRailgunTransactionsByBlockRange(
    chainDB,
    TEST_VECTOR_TRANSACT.number,
    TEST_VECTOR_TRANSACT.number
  ), [])
})

test('event processor TXID rows persist and advance independent cursor when inserted', () => {
  const chainDB = memChainDB()
  const chainID = NETWORK_CONFIG[NetworkName.EthereumSepolia].chainID
  const { railgunTransactions } = denormalizeBlockData(TEST_VECTOR_TRANSACT)

  assert.equal(insertRailgunTransactions(chainDB, railgunTransactions), 1)
  assert.equal(setTxidSyncCursor(chainDB, chainID, TEST_VECTOR_TRANSACT.number), 1)
  updateSyncState(chainDB, chainID, TEST_VECTOR_TRANSACT.number + 10n)

  const rows = getRailgunTransactionsByBlockRange(
    chainDB,
    TEST_VECTOR_TRANSACT.number,
    TEST_VECTOR_TRANSACT.number
  )

  assert.equal(rows.length, 1)
  assert.equal(getSyncState(chainDB, chainID)?.lastBlockHeight, TEST_VECTOR_TRANSACT.number + 10n)
  assert.equal(getTxidSyncCursor(chainDB, chainID), TEST_VECTOR_TRANSACT.number)
})
