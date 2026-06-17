import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { bytesToHex, hexToBytes } from '@railgun-reloaded/bytes'
import type { DBNote, WalletDB } from '@railgun-reloaded/storage'
import { createWallet, createWalletDB, insertNote } from '@railgun-reloaded/storage'

import { BalanceService, mapNoteRow } from '../../../src/services/balance/balance-service'

const ERC20_NULL_SUB_ID_HEX = `0x${'00'.repeat(32)}`
const ERC721_SUB_ID_HEX = `0x${'ab'.repeat(32)}`
const CHAIN_ID = 11155111

/**
 * Build a fresh in-memory wallet DB seeded with one wallet, returning the
 * DB handle and the wallet's id for use in tests.
 * @returns New fixture state per test.
 */
async function fixture (): Promise<{ db: WalletDB, walletId: string }> {
  const db = await createWalletDB({ path: ':memory:', runMigrations: true })
  const walletId = 'test-wallet'
  await createWallet(db, { id: walletId, encryptedKeys: Buffer.from('keys') })
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
    tokenType: 0,
    tokenSubID: new Uint8Array(32),
    spent: false,
    spentTxid: null,
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

test('mapNoteRow: ERC20 row exposes tokenType 0 and the 32-zero-byte tokenSubID hex', () => {
  const row = makeDBNote()
  const note = mapNoteRow(row)

  assert.equal(note.tokenType, 0)
  assert.equal(note.tokenSubID, ERC20_NULL_SUB_ID_HEX)
  assert.deepEqual(note.spendState, {
    spendable: true,
    poi: {
      kind: 'pending',
      reason: 'MissingExternalPOI'
    }
  })
})

test('mapNoteRow: ERC721 row exposes tokenType 1 and the original tokenSubID bytes as 0x-prefixed hex', () => {
  const row = makeDBNote({
    tokenType: 1,
    tokenSubID: hexToBytes(ERC721_SUB_ID_HEX),
  })
  const note = mapNoteRow(row)

  assert.equal(note.tokenType, 1)
  assert.equal(note.tokenSubID, ERC721_SUB_ID_HEX)
})

test('BalanceService.getNotes returns tokenType and tokenSubID for stored ERC20 + ERC721 notes', async () => {
  const { db, walletId } = await fixture()

  await insertNote(db, {
    commitment: hexToBytes(`0x${'aa'.repeat(32)}`),
    walletId,
    chainId: CHAIN_ID,
    nullifier: hexToBytes(`0x${'bb'.repeat(32)}`),
    token: '0x0000000000000000000000000000000000000000',
    amount: 500n,
    tokenType: 0,
    tokenSubID: new Uint8Array(32),
    blockNumber: 100n,
    treeNumber: 0,
    treePosition: 1,
    commitmentType: 1,
  })

  await insertNote(db, {
    commitment: hexToBytes(`0x${'cc'.repeat(32)}`),
    walletId,
    chainId: CHAIN_ID,
    nullifier: hexToBytes(`0x${'dd'.repeat(32)}`),
    token: '0x1111111111111111111111111111111111111111',
    amount: 1n,
    tokenType: 1,
    tokenSubID: hexToBytes(ERC721_SUB_ID_HEX),
    blockNumber: 101n,
    treeNumber: 0,
    treePosition: 2,
    commitmentType: 1,
  })

  const service = new BalanceService(db)
  const notes = await service.getNotes(walletId, CHAIN_ID)

  assert.equal(notes.length, 2)
  const erc20 = notes.find((n) => n.tokenType === 0)
  const erc721 = notes.find((n) => n.tokenType === 1)
  assert.ok(erc20, 'ERC20 note returned')
  assert.ok(erc721, 'ERC721 note returned')
  assert.equal(erc20!.tokenSubID, ERC20_NULL_SUB_ID_HEX)
  assert.equal(erc721!.tokenSubID, ERC721_SUB_ID_HEX)
  assert.equal(erc721!.token, '0x1111111111111111111111111111111111111111')
})

test('mapNoteRow preserves bytesToHex format on tokenSubID (matches commitment/nullifier convention)', () => {
  const row = makeDBNote()
  const note = mapNoteRow(row)

  assert.equal(note.commitment, bytesToHex(row.commitment, { prefix: true }))
  assert.equal(note.nullifier, bytesToHex(row.nullifier, { prefix: true }))
  assert.equal(note.tokenSubID, bytesToHex(row.tokenSubID, { prefix: true }))
})

test('mapNoteRow exposes spent state with public spentTxid hex', () => {
  const spentTxid = hexToBytes(`0x${'cd'.repeat(32)}`)
  const row = makeDBNote({
    spent: true,
    spentTxid
  })
  const note = mapNoteRow(row)

  assert.equal(note.spentTxid, `0x${'cd'.repeat(32)}`)
  assert.deepEqual(note.spendState, {
    spendable: false,
    poi: {
      kind: 'pending',
      reason: 'MissingExternalPOI'
    }
  })
})
