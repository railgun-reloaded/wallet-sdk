import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EncryptedCommitment, GeneratedCommitment, Shield, ShieldCommitment, Transact, TransactCommitment } from '@railgun-reloaded/scanner'
import { ActionType } from '@railgun-reloaded/scanner'
import {
  createChainDB,
  getCommitmentsByBlockRange,
  getNullifiersByBlockRange,
  insertCommitmentBatch,
  insertNullifiersBatch
} from '@railgun-reloaded/storage'

import { denormalizeBlockData, rehydrateActions } from '../src/sync'

import { TEST_VECTOR_ALL_ACTIONS, TEST_VECTOR_SHIELD, TEST_VECTOR_TRANSACT } from './test-vector'

/**
 * Build a fresh in-memory chain DB for round-trip tests.
 * @returns ChainDB with migrations applied.
 */
function memChainDB () {
  return createChainDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/chain'
  })
}

/**
 * Byte-equality for Uint8Array values produced by msgpack decoding. The
 * decoder returns views over a shared buffer (non-zero `byteOffset`), so
 * structural deep-equality reports them as different even when the bytes
 * match. Copy through Buffer to compare the bytes only.
 * TODO: Replace with `@railgun-reloaded/bytes` once the helper exists.
 * @param a - First byte array.
 * @param b - Second byte array.
 * @returns True when both have the same length and identical bytes.
 */
function bytesEqual (a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b))
}

test('rehydrateActions reconstructs a Shield from chain.db', () => {
  const db = memChainDB()
  const block = TEST_VECTOR_SHIELD
  const denormalized = denormalizeBlockData(block)
  insertCommitmentBatch(db, denormalized.commitments)

  const commitments = getCommitmentsByBlockRange(db, block.number, block.number)
  const nullifiers = getNullifiersByBlockRange(db, block.number, block.number)
  const { shields, transacts } = rehydrateActions({ commitments, nullifiers })

  assert.equal(shields.length, 1, 'one shield reconstructed')
  assert.equal(transacts.length, 0, 'no transacts')

  const original = block.transactions[0]!.actions[0]![0] as Shield
  const originalCommitment = original.commitment as ShieldCommitment
  const rehydrated = shields[0]!
  const rehydratedCommitment = rehydrated.commitment as ShieldCommitment

  assert.equal(rehydrated.actionType, ActionType.ShieldCommitment, 'discriminator preserved')
  assert.ok(bytesEqual(rehydratedCommitment.hash, originalCommitment.hash), 'hash reattached')
  assert.equal(rehydratedCommitment.treeNumber, originalCommitment.treeNumber, 'treeNumber reattached')
  assert.equal(rehydratedCommitment.treePosition, originalCommitment.treePosition, 'treePosition reattached')
  assert.ok(bytesEqual(rehydratedCommitment.preimage.npk, originalCommitment.preimage.npk), 'preimage.npk bytes match')
  assert.equal(rehydratedCommitment.preimage.value, originalCommitment.preimage.value, 'preimage.value round-trips')
  assert.ok(bytesEqual(rehydratedCommitment.preimage.token.tokenAddress, originalCommitment.preimage.token.tokenAddress), 'preimage.token.tokenAddress bytes match')
  assert.equal(rehydratedCommitment.encryptedBundle.length, originalCommitment.encryptedBundle.length, 'encryptedBundle length preserved')
  for (let i = 0; i < originalCommitment.encryptedBundle.length; i++) {
    assert.ok(bytesEqual(rehydratedCommitment.encryptedBundle[i]!, originalCommitment.encryptedBundle[i]!), `encryptedBundle[${i}] bytes match`)
  }
  assert.ok(bytesEqual(rehydratedCommitment.shieldKey, originalCommitment.shieldKey), 'shieldKey bytes match')
})

test('rehydrateActions discriminates GeneratedCommitment by encryptedRandom', () => {
  const db = memChainDB()
  const generated: Shield = {
    actionType: ActionType.GeneratedCommitment,
    batchStartTreePosition: 0,
    commitment: {
      hash: new Uint8Array(32).fill(1),
      treeNumber: 0,
      treePosition: 0,
      preimage: {
        npk: new Uint8Array(32),
        token: {
          id: new Uint8Array(32),
          tokenType: 'ERC20',
          tokenSubID: new Uint8Array(1),
          tokenAddress: new Uint8Array(20),
        },
        value: 1n,
      },
      encryptedRandom: [new Uint8Array(32), new Uint8Array(16)],
    } satisfies GeneratedCommitment,
  }
  const block = {
    number: 100n,
    hash: new Uint8Array(32),
    timestamp: 0n,
    transactions: [{
      hash: new Uint8Array(32).fill(2),
      index: 0,
      from: new Uint8Array(20),
      actions: [[generated]],
    }],
  }
  const { commitments } = denormalizeBlockData(block)
  insertCommitmentBatch(db, commitments)

  const rows = getCommitmentsByBlockRange(db, 100n, 100n)
  const { shields } = rehydrateActions({ commitments: rows, nullifiers: [] })

  assert.equal(shields.length, 1)
  assert.equal(shields[0]!.actionType, ActionType.GeneratedCommitment, 'GeneratedCommitment discriminator')
  assert.ok('encryptedRandom' in shields[0]!.commitment, 'encryptedRandom present after rehydration')
})

test('rehydrateActions reconstructs a Transact and attaches its nullifiers', () => {
  const db = memChainDB()
  const block = TEST_VECTOR_TRANSACT
  const { commitments, nullifiers } = denormalizeBlockData(block)
  insertCommitmentBatch(db, commitments)
  insertNullifiersBatch(db, nullifiers)

  const commitmentRows = getCommitmentsByBlockRange(db, block.number, block.number)
  const nullifierRows = getNullifiersByBlockRange(db, block.number, block.number)
  const { shields, transacts } = rehydrateActions({
    commitments: commitmentRows,
    nullifiers: nullifierRows
  })

  assert.equal(shields.length, 0, 'no shields in a pure transact block')
  assert.equal(transacts.length, 1, 'one transact group')

  const original = block.transactions[0]!.actions[0]![0] as Transact
  const rehydrated = transacts[0]!
  assert.equal(rehydrated.actionType, ActionType.TransactCommitment)
  assert.equal(rehydrated.commitments.length, original.commitments.length, 'commitment count preserved')
  assert.equal(rehydrated.nullifiers.length, original.nullifiers.length, 'nullifier count preserved')
  assert.ok(bytesEqual(rehydrated.txID, block.transactions[0]!.hash), 'txID set to transactionHash')

  for (let i = 0; i < original.commitments.length; i++) {
    const orig = original.commitments[i] as TransactCommitment
    const rehyd = rehydrated.commitments[i] as TransactCommitment
    assert.ok(bytesEqual(rehyd.hash, orig.hash), `commitment ${i} hash reattached`)
    assert.equal(rehyd.treeNumber, orig.treeNumber, `commitment ${i} treeNumber reattached`)
    assert.equal(rehyd.treePosition, orig.treePosition, `commitment ${i} treePosition reattached`)
    assert.ok(bytesEqual(rehyd.ciphertext.iv, orig.ciphertext.iv), `commitment ${i} ciphertext.iv bytes match`)
    assert.ok(bytesEqual(rehyd.ciphertext.tag, orig.ciphertext.tag), `commitment ${i} ciphertext.tag bytes match`)
    assert.equal(rehyd.ciphertext.data.length, orig.ciphertext.data.length, `commitment ${i} ciphertext.data length preserved`)
    for (let j = 0; j < orig.ciphertext.data.length; j++) {
      assert.ok(bytesEqual(rehyd.ciphertext.data[j]!, orig.ciphertext.data[j]!), `commitment ${i} ciphertext.data[${j}] bytes match`)
    }
  }
})

test('rehydrateActions discriminates legacy EncryptedCommitment by ephemeralKeys', () => {
  const db = memChainDB()
  const transact: Transact = {
    actionType: ActionType.EncryptedCommitment,
    txID: new Uint8Array(32),
    nullifiers: [new Uint8Array(32).fill(7)],
    commitments: [{
      hash: new Uint8Array(32).fill(3),
      ciphertext: { iv: new Uint8Array(16), tag: new Uint8Array(16), data: [new Uint8Array(32)] },
      memo: new Uint8Array(),
      ephemeralKeys: [new Uint8Array(32), new Uint8Array(32)],
      treeNumber: 0,
      treePosition: 0,
    } satisfies EncryptedCommitment],
    boundParamsHash: new Uint8Array(),
    utxoBatchStartPositionOut: 0,
    utxoTreeIn: 0,
    utxoTreeOut: 0,
    hasUnshield: false,
  }
  const block = {
    number: 200n,
    hash: new Uint8Array(32),
    timestamp: 0n,
    transactions: [{
      hash: new Uint8Array(32).fill(4),
      index: 0,
      from: new Uint8Array(20),
      actions: [[transact]],
    }],
  }
  const { commitments, nullifiers } = denormalizeBlockData(block)
  insertCommitmentBatch(db, commitments)
  insertNullifiersBatch(db, nullifiers)

  const rows = getCommitmentsByBlockRange(db, 200n, 200n)
  const nrows = getNullifiersByBlockRange(db, 200n, 200n)
  const { transacts } = rehydrateActions({ commitments: rows, nullifiers: nrows })

  assert.equal(transacts.length, 1)
  assert.ok('ephemeralKeys' in transacts[0]!.commitments[0]!,
    'ephemeralKeys present so processTransactAction routes to the legacy decryptor')
})

test('rehydrateActions handles a mixed block (shield + nullifier-only transact + unshield)', () => {
  const db = memChainDB()
  const block = TEST_VECTOR_ALL_ACTIONS
  const { commitments, nullifiers } = denormalizeBlockData(block)
  insertCommitmentBatch(db, commitments)
  insertNullifiersBatch(db, nullifiers)

  const commitmentRows = getCommitmentsByBlockRange(db, block.number, block.number)
  const nullifierRows = getNullifiersByBlockRange(db, block.number, block.number)
  const { shields, transacts } = rehydrateActions({
    commitments: commitmentRows,
    nullifiers: nullifierRows
  })

  // TEST_VECTOR_ALL_ACTIONS has a Shield + an Unshield + a Transact whose
  // `commitments: []` is empty (pure spend-into-unshield). With no transact
  // commitments persisted there is no group to rehydrate, so the orphan
  // nullifier doesn't surface as an action — that's fine for decryption
  // since spent-flag matching reads nullifiers directly from chain.db.
  assert.equal(shields.length, 1, 'one shield')
  assert.equal(transacts.length, 0, 'no transact group (no transact commitments stored)')
})
