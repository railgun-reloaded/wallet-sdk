import type { DBNewNote, WalletDB } from '@railgun-reloaded/storage'
import {
  createWallet,
  createWalletDB,
  insertNotesBatch
} from '@railgun-reloaded/storage'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { POIStatus, WalletBalanceBucket } from '../../src/poi'
import { BalanceService } from '../../src/services/balance/balance-service'
import type { TokenBalance } from '../../src/services/balance/balance-service'

const WALLET_ID = 'wallet-id'
const CHAIN_ID = 11155111
const LIST_KEY = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88'
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

function seedWallet (db: WalletDB): void {
  createWallet(db, {
    id: WALLET_ID,
    encryptedKeys: new Uint8Array([1, 2, 3]),
    name: 'bucket fixture wallet'
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
    poisPerList: {
      [LIST_KEY]: POIStatus.Valid
    },
    ...overrides
  }
}

function seedNotes (db: WalletDB, notes: DBNewNote[]): void {
  insertNotesBatch(db, notes)
}

function balanceOf (balances: TokenBalance[], token: string): bigint {
  return balances.find(balance => balance.token === token)?.balance ?? 0n
}

function sortBalances (balances: TokenBalance[]): TokenBalance[] {
  return [...balances].sort((a, b) => a.token.localeCompare(b.token))
}

function sumBucketBalances (
  byBucket: Record<WalletBalanceBucket, TokenBalance[]>
): TokenBalance[] {
  const sums = new Map<string, bigint>()
  for (const balances of Object.values(byBucket)) {
    for (const balance of balances) {
      sums.set(balance.token, (sums.get(balance.token) ?? 0n) + balance.balance)
    }
  }
  return [...sums.entries()].map(([token, balance]) => ({ token, balance }))
}

test('BalanceService.getBalancesByBucket aggregates unspent notes by bucket and token', async () => {
  const db = memWalletDB()
  seedWallet(db)
  seedNotes(db, [
    noteFixture(1, { token: USDC, amount: 100n }),
    noteFixture(2, { token: USDC, amount: 25n }),
    noteFixture(3, {
      token: USDC,
      amount: 50n,
      commitmentType: SHIELD_COMMITMENT_TYPE,
      outputType: null,
      poisPerList: null
    }),
    noteFixture(4, {
      token: USDC,
      amount: 7n,
      poisPerList: {
        [LIST_KEY]: POIStatus.ShieldBlocked
      }
    }),
    noteFixture(5, {
      token: DAI,
      amount: 9n,
      poisPerList: {
        [LIST_KEY]: POIStatus.ProofSubmitted
      }
    }),
    noteFixture(6, {
      token: DAI,
      amount: 11n,
      outputType: OUTPUT_TYPE_CHANGE,
      poisPerList: null
    }),
    noteFixture(7, {
      token: DAI,
      amount: 13n,
      outputType: OUTPUT_TYPE_TRANSFER,
      poisPerList: null
    }),
    noteFixture(8, {
      token: USDC,
      amount: 1000n,
      spent: true
    })
  ])

  const service = new BalanceService(db)
  const byBucket = await service.getBalancesByBucket(WALLET_ID, CHAIN_ID)

  assert.equal(balanceOf(byBucket[WalletBalanceBucket.Spendable], USDC), 125n)
  assert.equal(balanceOf(byBucket[WalletBalanceBucket.ShieldPending], USDC), 50n)
  assert.equal(balanceOf(byBucket[WalletBalanceBucket.ShieldBlocked], USDC), 7n)
  assert.equal(balanceOf(byBucket[WalletBalanceBucket.ProofSubmitted], DAI), 9n)
  assert.equal(balanceOf(byBucket[WalletBalanceBucket.MissingInternalPOI], DAI), 11n)
  assert.equal(balanceOf(byBucket[WalletBalanceBucket.MissingExternalPOI], DAI), 13n)
  assert.deepEqual(byBucket[WalletBalanceBucket.Spent], [])

  const total = await service.getBalances(WALLET_ID, CHAIN_ID, 'all')
  assert.deepEqual(sortBalances(sumBucketBalances(byBucket)), sortBalances(total))
  assert.deepEqual(
    sortBalances(await service.getBalances(WALLET_ID, CHAIN_ID)),
    sortBalances(byBucket[WalletBalanceBucket.Spendable])
  )
  assert.deepEqual(
    await service.getBalances(WALLET_ID, CHAIN_ID, WalletBalanceBucket.Spent),
    []
  )
})
