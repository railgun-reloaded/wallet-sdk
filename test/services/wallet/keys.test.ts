import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bytesToHex } from '@railgun-reloaded/bytes'
import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'

import { deriveWalletKeys } from '../../../src/services/wallet/keys'
import { MNEMONIC, VECTORS } from '../../fixtures/wallet-vectors'

test('deriveWalletKeys matches vectors for index 0', async () => {
  await initializeCryptographyLibs()
  const keys = deriveWalletKeys(MNEMONIC, 0)
  const v = VECTORS[0]!
  assert.equal(keys.walletId, v.walletId)
  assert.equal(bytesToHex(keys.masterPublicKey), v.masterPublicKey)
  assert.equal(bytesToHex(keys.viewingPublicKey), v.viewingPublicKey)
  assert.equal(bytesToHex(keys.viewingPrivateKey), v.viewingPrivateKey)
  assert.equal(bytesToHex(keys.nullifyingKey), v.nullifyingKey)
})

test('deriveWalletKeys matches vectors for index 1', async () => {
  await initializeCryptographyLibs()
  const keys = deriveWalletKeys(MNEMONIC, 1)
  const v = VECTORS[1]!
  assert.equal(keys.walletId, v.walletId)
  assert.equal(bytesToHex(keys.masterPublicKey), v.masterPublicKey)
})

test('deriveWalletKeys defaults index to 0', async () => {
  await initializeCryptographyLibs()
  const a = deriveWalletKeys(MNEMONIC)
  const b = deriveWalletKeys(MNEMONIC, 0)
  assert.equal(a.walletId, b.walletId)
})

test('deriveWalletKeys returns a railgunAddress starting with 0zk1', async () => {
  await initializeCryptographyLibs()
  const keys = deriveWalletKeys(MNEMONIC, 0)
  assert.ok(keys.railgunAddress.startsWith('0zk1'))
  assert.ok(keys.railgunAddress.length > 100)
})

test('deriveWalletKeys same mnemonic + different index => different address', async () => {
  await initializeCryptographyLibs()
  const a = deriveWalletKeys(MNEMONIC, 0)
  const b = deriveWalletKeys(MNEMONIC, 1)
  assert.notEqual(a.railgunAddress, b.railgunAddress)
  assert.notEqual(a.walletId, b.walletId)
})
