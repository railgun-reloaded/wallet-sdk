import type { DBNewNote, WalletDB } from '@railgun-reloaded/storage'
import {
  createWallet,
  createWalletDB,
  insertNotesBatch,
  recalculateAllBalances
} from '@railgun-reloaded/storage'
import { test } from 'brittle'

import { POIStatus, WalletBalanceBucket } from '../../src/poi'
import { BalanceService } from '../../src/services/balance/balance-service'
import type { TokenBalance } from '../../src/services/balance/balance-service'

const WALLET_ID = 'wallet-id'
const CHAIN_ID = 1
const LIST_KEY = 'list-key'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
const SHIELD_COMMITMENT_TYPE = 0
const TRANSACT_COMMITMENT_TYPE = 1
const OUTPUT_TYPE_TRANSFER = 0
const OUTPUT_TYPE_CHANGE = 2

function memWalletDB (): WalletDB {
  return createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
}

function bytes (value: number): Uint8Array {
  return new Uint8Array(32).fill(value)
}

function noteFixture (
  index: number,
  overrides: Partial<DBNewNote> = {}
): DBNewNote {
  return {
    commitment: bytes(index),
    walletId: WALLET_ID,
    chainId: CHAIN_ID,
    nullifier: bytes(index + 100),
    token: USDC,
    amount: 1n,
    spent: false,
    blockNumber: BigInt(index),
    treeNumber: 0,
    treePosition: index,
    commitmentType: TRANSACT_COMMITMENT_TYPE,
    outputType: OUTPUT_TYPE_TRANSFER,
    poisPerList: null,
    ...overrides
  }
}

function sortBalances (balances: TokenBalance[]): TokenBalance[] {
  return [...balances].sort((a, b) => a.token.localeCompare(b.token))
}

test('BalanceService treats every unspent note as Spendable on non-PPOI networks', async (t) => {
  const db = memWalletDB()
  createWallet(db, {
    id: WALLET_ID,
    encryptedKeys: new Uint8Array([1, 2, 3]),
    name: 'non-ppoi fixture wallet'
  })
  insertNotesBatch(db, [
    noteFixture(1, {
      token: USDC,
      amount: 100n,
      commitmentType: SHIELD_COMMITMENT_TYPE,
      outputType: null
    }),
    noteFixture(2, {
      token: USDC,
      amount: 20n,
      outputType: OUTPUT_TYPE_CHANGE
    }),
    noteFixture(3, {
      token: DAI,
      amount: 9n,
      poisPerList: {
        [LIST_KEY]: POIStatus.ShieldBlocked
      }
    }),
    noteFixture(4, {
      token: USDC,
      amount: 500n,
      spent: true
    })
  ])
  recalculateAllBalances(db, WALLET_ID, CHAIN_ID)

  const service = new BalanceService(db)
  const total = await service.getBalances(WALLET_ID, CHAIN_ID)
  const spendable = await service.getSpendableBalances(WALLET_ID, CHAIN_ID)
  const byBucket = await service.getBalancesByBucket(WALLET_ID, CHAIN_ID)

  t.alike(sortBalances(spendable), sortBalances(total))
  t.alike(sortBalances(byBucket[WalletBalanceBucket.Spendable]), sortBalances(total))
  for (const bucket of Object.values(WalletBalanceBucket)) {
    if (bucket !== WalletBalanceBucket.Spendable) {
      t.alike(byBucket[bucket], [])
    }
  }
})
