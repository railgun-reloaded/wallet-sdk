import {
  createChainDB,
  getRailgunTransactionsByBlockRange,
  getSyncState,
  getTxidSyncCursor,
  insertRailgunTransactions,
  setTxidSyncCursor,
  updateSyncState
} from '@railgun-reloaded/storage'
import { test } from 'brittle'

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

test('event processor exposes Railgun TXID rows without advancing cursor by itself', (t) => {
  const chainDB = memChainDB()
  const chainID = NETWORK_CONFIG[NetworkName.EthereumSepolia].chainID
  const { railgunTransactions } = denormalizeBlockData(TEST_VECTOR_TRANSACT)

  t.is(railgunTransactions.length, 1)

  updateSyncState(chainDB, chainID, TEST_VECTOR_TRANSACT.number)

  t.is(getSyncState(chainDB, chainID)?.lastBlockHeight, TEST_VECTOR_TRANSACT.number)
  t.is(getTxidSyncCursor(chainDB, chainID), 0n)
  t.alike(getRailgunTransactionsByBlockRange(
    chainDB,
    TEST_VECTOR_TRANSACT.number,
    TEST_VECTOR_TRANSACT.number
  ), [])
})

test('event processor TXID rows persist and advance independent cursor when inserted', (t) => {
  const chainDB = memChainDB()
  const chainID = NETWORK_CONFIG[NetworkName.EthereumSepolia].chainID
  const { railgunTransactions } = denormalizeBlockData(TEST_VECTOR_TRANSACT)

  t.is(insertRailgunTransactions(chainDB, railgunTransactions), 1)
  t.is(setTxidSyncCursor(chainDB, chainID, TEST_VECTOR_TRANSACT.number), 1)
  updateSyncState(chainDB, chainID, TEST_VECTOR_TRANSACT.number + 10n)

  const rows = getRailgunTransactionsByBlockRange(
    chainDB,
    TEST_VECTOR_TRANSACT.number,
    TEST_VECTOR_TRANSACT.number
  )

  t.is(rows.length, 1)
  t.is(getSyncState(chainDB, chainID)?.lastBlockHeight, TEST_VECTOR_TRANSACT.number + 10n)
  t.is(getTxidSyncCursor(chainDB, chainID), TEST_VECTOR_TRANSACT.number)
})
