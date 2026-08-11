import assert from 'node:assert/strict'
import { test } from 'node:test'

import { generateWalletId } from '../../../src/services/wallet/wallet-id.js'
import { MNEMONIC, VECTORS } from '../../fixtures/wallet-vectors.js'

test('generateWalletId matches vector for index 0', () => {
  assert.equal(generateWalletId(MNEMONIC, 0), VECTORS[0]!.walletId)
})

test('generateWalletId matches vector for index 1', () => {
  assert.equal(generateWalletId(MNEMONIC, 1), VECTORS[1]!.walletId)
})

test('generateWalletId defaults index to 0', () => {
  assert.equal(generateWalletId(MNEMONIC), VECTORS[0]!.walletId)
})

test('generateWalletId is deterministic', () => {
  assert.equal(generateWalletId(MNEMONIC, 0), generateWalletId(MNEMONIC, 0))
})

test('generateWalletId differs across indices', () => {
  assert.notEqual(generateWalletId(MNEMONIC, 0), generateWalletId(MNEMONIC, 1))
})

test('generateWalletId differs across mnemonics', () => {
  const other = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
  assert.notEqual(generateWalletId(MNEMONIC, 0), generateWalletId(other, 0))
})

test('generateWalletId rejects a negative or non-integer index', () => {
  assert.throws(() => generateWalletId(MNEMONIC, -1), RangeError)
  assert.throws(() => generateWalletId(MNEMONIC, 1.5), RangeError)
  assert.throws(() => generateWalletId(MNEMONIC, Number.NaN), RangeError)
})

test('generateWalletId returns unprefixed 64-character hex', () => {
  const id = generateWalletId(MNEMONIC, 0)
  assert.equal(id.length, 64)
  assert.ok(!id.startsWith('0x'))
  assert.ok(/^[0-9a-f]{64}$/.test(id))
})
