import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DBNewNote, DBNewRailgunTransaction } from '@railgun-reloaded/storage'
import {
  createChainDB,
  createChainStorage,
  createWalletDB,
  createWalletStorage
} from '@railgun-reloaded/storage/node'
import { TokenType } from '@railgun-reloaded/wallet-node'

import { RailgunClient } from '../../src/client.js'
import { buildTransactionHistory } from '../../src/history/history-service.js'
import type { NetworkConfig } from '../../src/network-config.js'
import { MNEMONIC } from '../fixtures/wallet-vectors.js'

const CHAIN_ID = 11155111
const TOKEN = '0x0000000000000000000000000000000000000abc'
const SECOND_TOKEN = '0x0000000000000000000000000000000000000def'
const SHIELD_TXID = new Uint8Array(32).fill(0xa1)
const RECEIVE_TXID = new Uint8Array(32).fill(0xb2)
const SEND_TXID = new Uint8Array(32).fill(0xc3)
const UNSHIELD_TXID = new Uint8Array(32).fill(0xd4)
const POI_CONFIG = {
  launchBlock: 1n,
  launchTimestamp: 0,
  requiredListKeys: ['test-list']
}

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
 * Build a Railgun transaction row carried by the unshielding EVM transaction.
 * @param overrides - Fields to override on the row.
 * @returns Railgun transaction row ready to insert.
 */
function railgunTransaction (
  overrides: Partial<DBNewRailgunTransaction>
): DBNewRailgunTransaction {
  return {
    railgunTxid: bytes32(0x30),
    txidVersion: 2,
    chainTxid: UNSHIELD_TXID,
    graphID: null,
    blockNumber: 70n,
    timestamp: 1_781_188_332n,
    nullifiers: [],
    commitments: [],
    boundParamsHash: bytes32(0x31),
    hasUnshield: false,
    unshield: null,
    utxoTreeIn: 0,
    utxoTreeOut: 0,
    utxoBatchStartPositionOut: 0,
    verificationHash: null,
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

  return { client, chainDB, walletDB, walletId: wallet.walletId }
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
  assert.equal(
    send.transferred[0]?.amount,
    60n,
    'the change returning to this wallet is not part of what was transferred'
  )
})

test('a self-held broadcaster fee is received but not transferred', async () => {
  const { client, walletId } = await seed([
    {
      commitment: bytes32(0x44),
      nullifier: bytes32(0x45),
      creationTxid: SHIELD_TXID,
      spent: true,
      spentTxid: SEND_TXID,
      spentBlockNumber: 30n
    },
    {
      commitment: bytes32(0x46),
      nullifier: bytes32(0x47),
      commitmentType: 1,
      outputType: 1,
      amount: 10n,
      blockNumber: 30n,
      creationTxid: SEND_TXID
    }
  ])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)
  const send = history.find((entry) => entry.txid === `0x${'c3'.repeat(32)}`)

  assert.equal(send?.received[0]?.kind, 'fee')
  assert.equal(
    send?.transferred[0]?.amount,
    90n,
    'the fee note this wallet holds did not leave its balance'
  )
})

test('a negative transferred residual raises a data error', async () => {
  const { client, walletId } = await seed([
    {
      commitment: bytes32(0x4c),
      nullifier: bytes32(0x4d),
      creationTxid: SHIELD_TXID,
      spent: true,
      spentTxid: SEND_TXID,
      spentBlockNumber: 30n
    },
    {
      commitment: bytes32(0x4e),
      nullifier: bytes32(0x4f),
      commitmentType: 1,
      outputType: 2,
      amount: 110n,
      blockNumber: 30n,
      creationTxid: SEND_TXID
    }
  ])

  await assert.rejects(
    client.getTransactionHistory(walletId, CHAIN_ID),
    {
      name: 'NegativeTransferredAmountError',
      message: `Negative transferred amount -10 for token ${TOKEN}:0:${`0x${'00'.repeat(32)}`}.`
    }
  )
})

test('an unshielded amount and its fee are not counted as a transfer', async () => {
  const { client, chainDB, walletId } = await seed([
    {
      commitment: bytes32(16),
      nullifier: bytes32(17),
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
    timestamp: 1_781_188_332n,
    toAddress: new Uint8Array(20).fill(0xee),
    amount: 90n,
    fee: 10n,
    eventLogIndex: 0
  }])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)
  const unshield = history.find((entry) => entry.category === 'unshield')

  assert.deepEqual(
    unshield?.transferred,
    [],
    'the whole spent note left through the unshield, so nothing was transferred'
  )
})

test('an unshield without a token is skipped for a multi-token spend', async () => {
  const { client, chainDB, walletId } = await seed([
    {
      commitment: bytes32(0x40),
      nullifier: bytes32(0x41),
      token: TOKEN,
      amount: 100n,
      spent: true,
      spentTxid: UNSHIELD_TXID,
      spentBlockNumber: 50n
    },
    {
      commitment: bytes32(0x42),
      nullifier: bytes32(0x43),
      token: SECOND_TOKEN,
      amount: 50n,
      spent: true,
      spentTxid: UNSHIELD_TXID,
      spentBlockNumber: 50n
    }
  ])

  await createChainStorage(chainDB).insertUnshieldBatch([{
    transactionHash: UNSHIELD_TXID,
    blockNumber: 50n,
    timestamp: 1_781_188_332n,
    toAddress: new Uint8Array(20).fill(0xee),
    amount: 90n,
    fee: 10n,
    eventLogIndex: 0
  }])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)
  const send = history.find((entry) => entry.txid === `0x${'d4'.repeat(32)}`)

  assert.deepEqual(send?.unshields, [])
  assert.deepEqual(
    send?.transferred.map(({ token, amount }) => ({ token, amount })),
    [
      { token: TOKEN, amount: 100n },
      { token: SECOND_TOKEN, amount: 50n }
    ],
    'an unknown unshield token does not alter either token total'
  )
})

test('a zero-value note does not reach the history', async () => {
  const { client, walletId } = await seed([
    {
      commitment: bytes32(18),
      commitmentType: 1,
      amount: 0n,
      creationTxid: RECEIVE_TXID
    }
  ])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)

  assert.deepEqual(history, [], 'a note padding a circuit moves no value')
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
    'an indexer reports the block time in milliseconds'
  )
  assert.equal(
    unshield.unshields[0]?.token,
    TOKEN,
    'an unshield with no stored token falls back to the spent note token'
  )
})

test('an unshield timestamp in seconds reports the same instant', async () => {
  const { client, chainDB, walletId } = await seed([
    {
      commitment: bytes32(12),
      nullifier: bytes32(13),
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
    // An RPC source passes the raw EVM block timestamp through, in seconds.
    timestamp: 1_781_188_332n,
    toAddress: new Uint8Array(20).fill(0xee),
    amount: 90n,
    fee: 10n,
    eventLogIndex: 0
  }])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)
  const unshield = history.find((entry) => entry.category === 'unshield')

  assert.deepEqual(unshield?.timestamp, new Date('2026-06-11T14:32:12.000Z'))
})

test('unshield events do not replace a known spent timestamp', async () => {
  const spentTimestamp = new Date('2026-01-02T03:04:05.000Z')
  const { client, chainDB, walletId } = await seed([
    {
      commitment: bytes32(0x55),
      nullifier: bytes32(0x56),
      creationTxid: SHIELD_TXID,
      spent: true,
      spentTxid: UNSHIELD_TXID,
      spentBlockNumber: 50n,
      spentTimestamp
    }
  ])

  await createChainStorage(chainDB).insertUnshieldBatch([
    {
      transactionHash: UNSHIELD_TXID,
      blockNumber: 50n,
      timestamp: 1_781_188_332n,
      toAddress: new Uint8Array(20).fill(0xee),
      amount: 40n,
      fee: 0n,
      eventLogIndex: 0
    },
    {
      transactionHash: UNSHIELD_TXID,
      blockNumber: 50n,
      timestamp: 1_781_188_333n,
      toAddress: new Uint8Array(20).fill(0xef),
      amount: 50n,
      fee: 10n,
      eventLogIndex: 1
    }
  ])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)
  const unshield = history.find((entry) => entry.category === 'unshield')

  assert.equal(unshield?.unshields.length, 2)
  assert.deepEqual(unshield?.timestamp, spentTimestamp)
})

test('a note carries its token standard into the history', async () => {
  const { client, walletId } = await seed([
    {
      commitment: bytes32(14),
      commitmentType: 0,
      tokenType: TokenType.ERC721,
      tokenSubID: bytes32(15),
      creationTxid: SHIELD_TXID
    }
  ])

  const [entry] = await client.getTransactionHistory(walletId, CHAIN_ID)

  assert.equal(entry?.received[0]?.tokenType, TokenType.ERC721)
  assert.equal(entry?.received[0]?.tokenSubID, `0x${'0f'.repeat(32)}`)
})

test('an ERC-1155 note does not hide supported token history', async () => {
  const { client, walletId } = await seed([
    {
      commitment: bytes32(0x50),
      nullifier: bytes32(0x51),
      token: SECOND_TOKEN,
      tokenType: TokenType.ERC1155,
      tokenSubID: bytes32(0x52),
      creationTxid: RECEIVE_TXID
    },
    {
      commitment: bytes32(0x53),
      nullifier: bytes32(0x54),
      treePosition: 1,
      token: TOKEN,
      tokenType: TokenType.ERC20,
      creationTxid: SHIELD_TXID
    }
  ])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)

  assert.equal(history.length, 1)
  assert.equal(history[0]?.received[0]?.token, TOKEN)
  assert.equal(history[0]?.received[0]?.tokenType, TokenType.ERC20)
})

test('a not-configured note keeps a mixed transaction from reading as cleared', async () => {
  const { walletDB, walletId } = await seed([
    {
      commitment: bytes32(0x48),
      nullifier: bytes32(0x4a),
      creationTxid: RECEIVE_TXID,
      poisPerList: { 'test-list': 'Valid' }
    },
    {
      commitment: bytes32(0x49),
      nullifier: bytes32(0x4b),
      treePosition: 1,
      creationTxid: RECEIVE_TXID,
      poisPerList: { 'test-list': 'Valid' }
    }
  ])
  const spendStates = []

  for (const poiOrder of [
    [POI_CONFIG, POI_CONFIG, undefined],
    [undefined, POI_CONFIG, POI_CONFIG]
  ]) {
    let poiIndex = 0
    const network: NetworkConfig = {
      chainID: CHAIN_ID,
      deploymentBlock: 1n,
      proxyContractAddress: '0x0000000000000000000000000000000000000000',
      rpcURL: 'https://rpc.example',
      poi: POI_CONFIG
    }
    Object.defineProperty(network, 'poi', {
      /**
       * Reverse the state order without exposing the internal reducer.
       * @returns The next PPOI configuration in the ordering under test.
       */
      get: () => {
        const poi = poiOrder[poiIndex]
        poiIndex += 1
        return poi
      }
    })
    const [entry] = await buildTransactionHistory({
      walletStorage: createWalletStorage(walletDB),
      chainStorage: undefined,
      walletId,
      chainId: CHAIN_ID,
      network
    })
    spendStates.push(entry?.spendState)
  }

  assert.deepEqual(spendStates, [
    { spendable: true, poi: null },
    { spendable: true, poi: null }
  ])
})

test('another wallet\'s unshield in the same transaction is not attributed here', async () => {
  const OUR_NULLIFIER = bytes32(0x21)
  const STRANGER_NULLIFIER = bytes32(0x22)
  const STRANGER_ADDRESS = new Uint8Array(20).fill(0xcc)

  const { client, chainDB, walletId } = await seed([
    {
      commitment: bytes32(0x23),
      nullifier: OUR_NULLIFIER,
      commitmentType: 0,
      creationTxid: SHIELD_TXID,
      spent: true,
      spentTxid: UNSHIELD_TXID,
      spentBlockNumber: 70n
    }
  ])

  const chainStorage = createChainStorage(chainDB)
  await chainStorage.insertRailgunTransactions([
    railgunTransaction({
      railgunTxid: bytes32(0x24),
      nullifiers: [OUR_NULLIFIER],
      hasUnshield: false,
      unshield: null
    }),
    railgunTransaction({
      railgunTxid: bytes32(0x25),
      nullifiers: [STRANGER_NULLIFIER],
      hasUnshield: true,
      unshield: { to: STRANGER_ADDRESS, token: null, value: 90n }
    })
  ])
  await chainStorage.insertUnshieldBatch([{
    transactionHash: UNSHIELD_TXID,
    blockNumber: 70n,
    timestamp: 1_781_188_332n,
    toAddress: STRANGER_ADDRESS,
    amount: 90n,
    fee: 10n,
    eventLogIndex: 0
  }])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)
  const entry = history.find((item) => item.txid === `0x${'d4'.repeat(32)}`)

  assert.deepEqual(
    entry?.unshields,
    [],
    'the unshield belongs to the Railgun transaction that spent another wallet\'s note'
  )
  assert.equal(entry?.category, 'send', 'this wallet only spent in that transaction')
  assert.equal(
    entry?.transferred[0]?.amount,
    100n,
    'the stranger\'s unshield is not deducted from this wallet\'s transferred total'
  )
})

test('the same ERC-20 reports one sub-ID whatever width its source stored', async () => {
  const { client, walletDB, walletId } = await seed([
    {
      commitment: bytes32(20),
      commitmentType: 0,
      // A data source can store the ERC-20 sub-ID narrower than the chain does.
      tokenSubID: new Uint8Array([0]),
      creationTxid: SHIELD_TXID
    }
  ])

  await createWalletStorage(walletDB).insertTxHistoryBatch([{
    id: 'pending-shield',
    walletId,
    chainId: CHAIN_ID,
    type: 'shield' as const,
    txid: `0x${'ab'.repeat(32)}`,
    blockNumber: 60n,
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    metadata: { token: TOKEN, tokenType: 0, tokenSubID: '0x00', amount: '5' }
  }])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)
  const derived = history.find((entry) => !entry.pending)
  const pending = history.find((entry) => entry.pending)

  assert.equal(derived?.received[0]?.tokenSubID, `0x${'00'.repeat(32)}`)
  assert.equal(
    pending?.received[0]?.tokenSubID,
    derived?.received[0]?.tokenSubID,
    'a recorded shield and its decrypted twin name the same token'
  )
})

test('recorded transactions past the storage page size still reach the history', async () => {
  const RECORDED = 120
  const { client, walletDB, walletId } = await seed([])

  await createWalletStorage(walletDB).insertTxHistoryBatch(
    Array.from({ length: RECORDED }, (_, index) => ({
      id: `recorded-${index}`,
      walletId,
      chainId: CHAIN_ID,
      type: 'shield' as const,
      txid: `0x${index.toString(16).padStart(64, '0')}`,
      blockNumber: BigInt(index + 1),
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      metadata: { token: TOKEN, tokenType: 0, amount: '5' }
    }))
  )

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)

  assert.equal(
    history.length,
    RECORDED,
    'the storage row default does not truncate the set the merge dedupes'
  )
})

test('no amount reports a token address that names no contract', async () => {
  const { client, chainDB, walletDB, walletId } = await seed([
    {
      commitment: bytes32(0x26),
      commitmentType: 1,
      // Received in a block this wallet also spent in, but in another
      // transaction, so no note of this wallet names the unshield's token.
      creationTxid: RECEIVE_TXID,
      blockNumber: 80n
    },
    {
      commitment: bytes32(0x27),
      nullifier: bytes32(0x28),
      commitmentType: 0,
      creationTxid: SHIELD_TXID,
      spent: true,
      spentTxid: SEND_TXID,
      spentBlockNumber: 80n
    }
  ])

  await createChainStorage(chainDB).insertUnshieldBatch([{
    transactionHash: RECEIVE_TXID,
    blockNumber: 80n,
    timestamp: 1_781_188_332n,
    toAddress: new Uint8Array(20).fill(0xee),
    amount: 90n,
    fee: 10n,
    eventLogIndex: 0
  }])
  await createWalletStorage(walletDB).insertTxHistoryBatch([{
    id: 'recorded-no-token',
    walletId,
    chainId: CHAIN_ID,
    type: 'shield' as const,
    txid: `0x${'ef'.repeat(32)}`,
    blockNumber: 90n,
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    metadata: { amount: '5' }
  }])

  const history = await client.getTransactionHistory(walletId, CHAIN_ID)
  const amounts = history.flatMap((entry) => [
    ...entry.received,
    ...entry.spent,
    ...entry.transferred,
    ...entry.unshields
  ])

  assert.ok(amounts.length > 0, 'the history reports amounts to check')
  assert.deepEqual(
    amounts.filter((amount) => amount.token === ''),
    [],
    'an amount whose token cannot be named is not reported'
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
