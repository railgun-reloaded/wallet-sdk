import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'
import { test } from 'brittle'

import { deriveWalletKeys } from '../../../src/services/wallet/keys'
import { MNEMONIC, VECTORS } from '../../fixtures/wallet-vectors'

/**
 * Encode bytes as unprefixed lowercase hex for comparison with fixture strings.
 * @param bytes - Input buffer.
 * @returns Hex representation.
 */
function toHex (bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0')
  }
  return hex
}

test('deriveWalletKeys matches vectors for index 0', async (t) => {
  await initializeCryptographyLibs()
  const keys = deriveWalletKeys(MNEMONIC, 0)
  const v = VECTORS[0]!
  t.is(keys.walletId, v.walletId)
  t.is(toHex(keys.masterPublicKey), v.masterPublicKey)
  t.is(toHex(keys.viewingPublicKey), v.viewingPublicKey)
  t.is(toHex(keys.viewingPrivateKey), v.viewingPrivateKey)
  t.is(toHex(keys.nullifyingKey), v.nullifyingKey)
})

test('deriveWalletKeys matches vectors for index 1', async (t) => {
  await initializeCryptographyLibs()
  const keys = deriveWalletKeys(MNEMONIC, 1)
  const v = VECTORS[1]!
  t.is(keys.walletId, v.walletId)
  t.is(toHex(keys.masterPublicKey), v.masterPublicKey)
})

test('deriveWalletKeys defaults index to 0', async (t) => {
  await initializeCryptographyLibs()
  const a = deriveWalletKeys(MNEMONIC)
  const b = deriveWalletKeys(MNEMONIC, 0)
  t.is(a.walletId, b.walletId)
})

test('deriveWalletKeys returns a railgunAddress starting with 0zk1', async (t) => {
  await initializeCryptographyLibs()
  const keys = deriveWalletKeys(MNEMONIC, 0)
  t.ok(keys.railgunAddress.startsWith('0zk1'))
  t.ok(keys.railgunAddress.length > 100)
})

test('deriveWalletKeys same mnemonic + different index => different address', async (t) => {
  await initializeCryptographyLibs()
  const a = deriveWalletKeys(MNEMONIC, 0)
  const b = deriveWalletKeys(MNEMONIC, 1)
  t.not(a.railgunAddress, b.railgunAddress)
  t.not(a.walletId, b.walletId)
})
