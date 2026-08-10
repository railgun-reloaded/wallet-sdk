import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { hexToBytes } from '@railgun-reloaded/bytes'
import type { DBNote, WalletStorage } from '@railgun-reloaded/storage'
import { createWalletDB, createWalletStorage } from '@railgun-reloaded/storage/node'
import { TokenType } from '@railgun-reloaded/wallet-node'

import { BalanceService } from '../../../src/services/balance/balance-service.js'

const ERC20_NULL_SUB_ID_HEX = `0x${'00'.repeat(32)}`
const ERC721_SUB_ID_HEX = `0x${'ab'.repeat(32)}`
const CHAIN_ID = 11155111

/**
 * Build a fresh in-memory wallet DB seeded with one wallet, returning the
 * DB handle and the wallet's id for use in tests.
 * @returns New fixture state per test.
 */
async function fixture (): Promise<{ db: WalletStorage, walletId: string }> {
  const db = createWalletStorage(await createWalletDB({ path: ':memory:', runMigrations: true }))
  const walletId = 'test-wallet'
  await db.createWallet({ id: walletId, encryptedKeys: Buffer.from('keys') })
  return { db, walletId }
}

/**
 * Build a base ERC20 DBNote-shaped row, allowing per-test overrides.
 * @param overrides - Fields to replace on the default row.
 * @returns A DBNote with sensible defaults.
 */
function makeDBNote (overrides: Partial<DBNote> = {}): DBNote {
  return {
    commitment: Uint8Array.from(randomBytes(32)),
    walletId: 'test-wallet',
    chainId: CHAIN_ID,
    nullifier: Uint8Array.from(randomBytes(32)),
    token: '0x0000000000000000000000000000000000000000',
    amount: 1000n,
    tokenType: TokenType.ERC20,
    tokenSubID: new Uint8Array(32),
    spent: false,
    spentTxid: null,
    spentBlockNumber: null,
    spentTimestamp: null,
    blockNumber: 100n,
    treeNumber: 0,
    treePosition: 0,
    commitmentType: 1,
    outputType: null,
    npk: null,
    random: null,
    blindedCommitment: null,
    creationRailgunTxid: null,
    creationTxid: null,
    poisPerList: null,
    decryptedAt: new Date(),
    ...overrides,
  }
}

test('BalanceService.getNotes returns tokenType and tokenSubID for stored ERC20 + ERC721 notes', async () => {
  const { db, walletId } = await fixture()

  await db.insertNote({
    commitment: hexToBytes(`0x${'aa'.repeat(32)}`),
    walletId,
    chainId: CHAIN_ID,
    nullifier: hexToBytes(`0x${'bb'.repeat(32)}`),
    token: '0x0000000000000000000000000000000000000000',
    amount: 500n,
    tokenType: TokenType.ERC20,
    tokenSubID: new Uint8Array(32),
    blockNumber: 100n,
    treeNumber: 0,
    treePosition: 1,
    commitmentType: 1,
  })

  await db.insertNote({
    commitment: hexToBytes(`0x${'cc'.repeat(32)}`),
    walletId,
    chainId: CHAIN_ID,
    nullifier: hexToBytes(`0x${'dd'.repeat(32)}`),
    token: '0x1111111111111111111111111111111111111111',
    amount: 1n,
    tokenType: TokenType.ERC721,
    tokenSubID: hexToBytes(ERC721_SUB_ID_HEX),
    blockNumber: 101n,
    treeNumber: 0,
    treePosition: 2,
    commitmentType: 1,
  })

  const service = new BalanceService(db)
  const notes = await service.getNotes(walletId, CHAIN_ID)

  assert.equal(notes.length, 2)
  const erc20 = notes.find((n) => n.tokenType === TokenType.ERC20)
  const erc721 = notes.find((n) => n.tokenType === TokenType.ERC721)
  assert.ok(erc20, 'ERC20 note returned')
  assert.ok(erc721, 'ERC721 note returned')
  assert.equal(erc20!.tokenSubID, ERC20_NULL_SUB_ID_HEX)
  assert.equal(erc721!.tokenSubID, ERC721_SUB_ID_HEX)
  assert.equal(erc721!.token, '0x1111111111111111111111111111111111111111')
})

test('BalanceService.getNFTs returns only unspent ERC721 contract and token IDs', async () => {
  const { db, walletId } = await fixture()
  const nftContract = '0x1111111111111111111111111111111111111111'

  await db.insertNotesBatch([
    makeDBNote({
      commitment: hexToBytes(`0x${'11'.repeat(32)}`),
      nullifier: hexToBytes(`0x${'12'.repeat(32)}`),
      walletId,
      tokenType: TokenType.ERC20
    }),
    makeDBNote({
      commitment: hexToBytes(`0x${'21'.repeat(32)}`),
      nullifier: hexToBytes(`0x${'22'.repeat(32)}`),
      walletId,
      token: nftContract,
      tokenType: TokenType.ERC721,
      tokenSubID: hexToBytes(ERC721_SUB_ID_HEX)
    }),
    makeDBNote({
      commitment: hexToBytes(`0x${'31'.repeat(32)}`),
      nullifier: hexToBytes(`0x${'32'.repeat(32)}`),
      walletId,
      token: nftContract,
      tokenType: TokenType.ERC721,
      tokenSubID: hexToBytes(`0x${'cd'.repeat(32)}`),
      spent: true
    })
  ])

  const service = new BalanceService(db)
  assert.deepEqual(await service.getNFTs(walletId, CHAIN_ID), [{
    token: nftContract,
    tokenSubID: ERC721_SUB_ID_HEX
  }])
})
