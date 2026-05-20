import type { DBNewNote, WalletDB } from '@railgun-reloaded/storage'
import {
  createWallet,
  createWalletDB,
  insertNotesBatch,
  recalculateAllBalances
} from '@railgun-reloaded/storage'
import { test } from 'brittle'

import {
  CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY,
  POIStatus
} from '../../src/poi'
import { BalanceService } from '../../src/services/balance/balance-service'
import type { TokenBalance } from '../../src/services/balance/balance-service'

const WALLET_ID = 'wallet-id'
const CHAIN_ID = 11155111
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
    poisPerList: {
      [CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY]: POIStatus.Valid
    },
    ...overrides
  }
}

function seedWalletWithMixedPoiStates (db: WalletDB): void {
  createWallet(db, {
    id: WALLET_ID,
    encryptedKeys: new Uint8Array([1, 2, 3]),
    name: 'parity fixture wallet'
  })
  insertNotesBatch(db, [
    noteFixture(1, { token: USDC, amount: 70n }),
    noteFixture(2, {
      token: USDC,
      amount: 30n,
      outputType: OUTPUT_TYPE_CHANGE
    }),
    noteFixture(3, { token: DAI, amount: 5n }),
    noteFixture(4, {
      token: USDC,
      amount: 400n,
      commitmentType: SHIELD_COMMITMENT_TYPE,
      outputType: null,
      poisPerList: null
    }),
    noteFixture(5, {
      token: DAI,
      amount: 7n,
      outputType: OUTPUT_TYPE_TRANSFER,
      poisPerList: null
    }),
    noteFixture(6, {
      token: USDC,
      amount: 9n,
      poisPerList: {
        [CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY]: POIStatus.ProofSubmitted
      }
    }),
    noteFixture(7, {
      token: USDC,
      amount: 1000n,
      spent: true
    })
  ])
  recalculateAllBalances(db, WALLET_ID, CHAIN_ID)
}

function balanceOf (balances: TokenBalance[], token: string): bigint {
  return balances.find(balance => balance.token === token)?.balance ?? 0n
}

function sumBalances (balances: TokenBalance[]): bigint {
  return balances.reduce((sum, balance) => sum + balance.balance, 0n)
}

test('BalanceService.getSpendableBalances equals hand-counted spendable bucket', async (t) => {
  const db = memWalletDB()
  seedWalletWithMixedPoiStates(db)
  const service = new BalanceService(db)

  const spendable = await service.getSpendableBalances(WALLET_ID, CHAIN_ID)
  const total = await service.getBalances(WALLET_ID, CHAIN_ID)

  t.is(balanceOf(spendable, USDC), 100n)
  t.is(balanceOf(spendable, DAI), 5n)
  t.is(sumBalances(spendable), 105n)
  t.ok(sumBalances(total) > sumBalances(spendable), 'mixed POI states keep total greater than spendable')
})
