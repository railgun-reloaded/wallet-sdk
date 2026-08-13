import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DBNewNote } from '@railgun-reloaded/storage'
import {
  createChainDB,
  createChainStorage,
  createWalletDB,
  createWalletStorage
} from '@railgun-reloaded/storage/node'

import { RailgunClient } from '../../src/client.js'
import { MNEMONIC } from '../fixtures/wallet-vectors.js'

const CHAIN_ID = 11155111
const TOKEN = '0x0000000000000000000000000000000000000abc'
const SHIELD_TXID = new Uint8Array(32).fill(0xa1)
const RECEIVE_TXID = new Uint8Array(32).fill(0xb2)
const SEND_TXID = new Uint8Array(32).fill(0xc3)
const UNSHIELD_TXID = new Uint8Array(32).fill(0xd4)

/**
 * Build 32 deterministic bytes.
 * @param value - Byte value to fill with.
 * @returns Filled 32-byte array.
 */
function bytes32 (value: number): Uint8Array {
  return new Uint8Array(32).fill(value)
}

/**
 * Build a note row with the fields the history derivation reads.
 * @param overrides - Fields to override on the note.
 * @returns Note row ready to insert.
 */
function note (overrides: Partial<DBNewNote>): DBNewNote {
  return {
    commitment: bytes32(1),
    walletId: 'wallet-id',
    chainId: CHAIN_ID,
    nullifier: bytes32(2),
    token: TOKEN,
    amount: 100n,
    spent: false,
    blockNumber: 10n,
    treeNumber: 0,
    treePosition: 0,
    commitmentType: 0,
    decryptedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  }
}

/**
 * Open a client over in-memory databases and seed one wallet's notes.
 * @param notes - Notes to insert for the wallet.
 * @returns The open client and the seeded wallet id.
 */
async function seed (notes: Partial<DBNewNote>[]) {
  const walletDB = await createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
  const chainDB = await createChainDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/chain'
  })
  const client = await RailgunClient.create({ walletDB, chainDB })
  const wallet = await client.createWallet({
    mnemonic: MNEMONIC,
    encryptionKey: new Uint8Array(32).fill(1)
  })

  await createWalletStorage(walletDB).insertNotesBatch(
    notes.map((overrides) => note({ ...overrides, walletId: wallet.walletId }))
  )

  return { client, chainDB, walletId: wallet.walletId }
}

test('a shield commitment is reported as a shield', async () => {
  const { client, walletId } = await seed([
    { commitment: bytes32(1), commitmentType: 0, creationTxid: SHIELD_TXID }
  ])

  const [entry] = await client.getTransactionHistory(walletId, CHAIN_ID)

  assert.equal(entry?.category, 'shield')
  assert.equal(entry?.received[0]?.kind, 'shield')
  assert.equal(entry?.received[0]?.amount, 100n)
  assert.equal(entry?.spent.length, 0)
})

test('a transact commitment with no sender annotation is a receive', async () => {
  const { client, walletId } = await seed([
    {
      commitment: bytes32(3),
      commitmentType: 1,
      outputType: null,
      creationTxid: RECEIVE_TXID
    }
  ])

  const [entry] = await client.getTransactionHistory(walletId, CHAIN_ID)

  assert.equal(entry?.category, 'receive')
  assert.equal(entry?.received[0]?.kind, 'transfer')
})

test('spending a note and taking change back is a send', async () => {
  const { client, walletId } = await seed([
    {
      commitment: bytes32(4),
      nullifier: bytes32(5),
      commitmentType: 0,
      creationTxid: SHIELD_TXID,
      spent: true,
      spentTxid: SEND_TXID,
      spentBlockNumber: 30n
    },
    {
      commitment: bytes32(6),
      nullifier: bytes32(7),
      commitmentType: 1,
      outputType: 2,
      amount: 40n,
      blockNumber: 30n,
      creationTxid: SEND_TXID
    }
  ])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)
  const send = history.find((entry) => entry.category === 'send')

  assert.ok(send !== undefined, 'the spending transaction is categorised as a send')
  assert.equal(send.spent[0]?.amount, 100n)
  assert.equal(send.received[0]?.kind, 'change')
  assert.equal(send.received[0]?.amount, 40n)
})

test('a spend whose transaction unshielded is reported as an unshield', async () => {
  const { client, chainDB, walletId } = await seed([
    {
      commitment: bytes32(8),
      nullifier: bytes32(9),
      commitmentType: 0,
      creationTxid: SHIELD_TXID,
      spent: true,
      spentTxid: UNSHIELD_TXID,
      spentBlockNumber: 50n
    }
  ])

  await createChainStorage(chainDB).insertUnshieldBatch([{
    transactionHash: UNSHIELD_TXID,
    blockNumber: 50n,
    timestamp: 1_781_188_332_000n,
    toAddress: new Uint8Array(20).fill(0xee),
    amount: 90n,
    fee: 10n,
    eventLogIndex: 0
  }])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)
  const unshield = history.find((entry) => entry.category === 'unshield')

  assert.ok(unshield !== undefined, 'the unshielding transaction is categorised')
  assert.equal(unshield.unshields[0]?.amount, 90n)
  assert.equal(unshield.unshields[0]?.fee, 10n)
  assert.deepEqual(
    unshield.timestamp,
    new Date('2026-06-11T14:32:12.000Z'),
    'unshield events store the block time in milliseconds'
  )
  assert.equal(
    unshield.unshields[0]?.token,
    TOKEN,
    'an unshield with no stored token falls back to the spent note token'
  )
})

test('an unshield in another block is not attached to this wallet', async () => {
  const { client, chainDB, walletId } = await seed([
    {
      commitment: bytes32(10),
      nullifier: bytes32(11),
      commitmentType: 0,
      creationTxid: SHIELD_TXID,
      spent: true,
      spentTxid: SEND_TXID,
      spentBlockNumber: 30n
    }
  ])

  await createChainStorage(chainDB).insertUnshieldBatch([{
    transactionHash: UNSHIELD_TXID,
    blockNumber: 999n,
    timestamp: 1_760_000_000n,
    toAddress: new Uint8Array(20).fill(0xee),
    amount: 90n,
    fee: 10n,
    eventLogIndex: 0
  }])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)

  assert.equal(
    history.some((entry) => entry.category === 'unshield'),
    false,
    'only unshields in a block this wallet spent in are considered'
  )
})
