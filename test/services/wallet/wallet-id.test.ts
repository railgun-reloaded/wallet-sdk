import { test } from 'brittle'

import { generateWalletId } from '../../../src/services/wallet/wallet-id'
import { MNEMONIC, VECTORS } from '../../fixtures/wallet-vectors'

test('generateWalletId matches vector for index 0', (t) => {
  t.is(generateWalletId(MNEMONIC, 0), VECTORS[0]!.walletId)
})

test('generateWalletId matches vector for index 1', (t) => {
  t.is(generateWalletId(MNEMONIC, 1), VECTORS[1]!.walletId)
})

test('generateWalletId defaults index to 0', (t) => {
  t.is(generateWalletId(MNEMONIC), VECTORS[0]!.walletId)
})

test('generateWalletId is deterministic', (t) => {
  t.is(generateWalletId(MNEMONIC, 0), generateWalletId(MNEMONIC, 0))
})

test('generateWalletId differs across indices', (t) => {
  t.not(generateWalletId(MNEMONIC, 0), generateWalletId(MNEMONIC, 1))
})

test('generateWalletId differs across mnemonics', (t) => {
  const other = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
  t.not(generateWalletId(MNEMONIC, 0), generateWalletId(other, 0))
})

test('generateWalletId returns unprefixed 64-character hex', (t) => {
  const id = generateWalletId(MNEMONIC, 0)
  t.is(id.length, 64)
  t.absent(id.startsWith('0x'))
  t.ok(/^[0-9a-f]{64}$/.test(id))
})
