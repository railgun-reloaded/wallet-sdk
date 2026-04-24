import { randomBytes } from 'node:crypto'

import { test } from 'brittle'

import { InvalidEncryptionKeyError } from '../../../src/services/wallet/errors'
import {
  decryptWalletBlob,
  encryptWalletBlob
} from '../../../src/services/wallet/wallet-crypto'

test('encrypt / decrypt round-trip returns the same blob', (t) => {
  const key = new Uint8Array(randomBytes(32))
  const blob = {
    mnemonic: 'test test test test test test test test test test test junk',
    index: 0
  }
  const packed = encryptWalletBlob(blob, key)
  const decrypted = decryptWalletBlob(packed, key)
  t.is(decrypted.mnemonic, blob.mnemonic)
  t.is(decrypted.index, blob.index)
})

test('decrypt with wrong key throws InvalidEncryptionKeyError', (t) => {
  const key = new Uint8Array(randomBytes(32))
  const wrongKey = new Uint8Array(randomBytes(32))
  const packed = encryptWalletBlob({ mnemonic: 'm', index: 0 }, key)
  try {
    decryptWalletBlob(packed, wrongKey)
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('decrypt of tampered ciphertext throws InvalidEncryptionKeyError', (t) => {
  const key = new Uint8Array(randomBytes(32))
  const packed = encryptWalletBlob({ mnemonic: 'm', index: 0 }, key)
  packed[packed.length - 1]! ^= 0xff
  try {
    decryptWalletBlob(packed, key)
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('encrypt with non-32-byte key throws InvalidEncryptionKeyError', (t) => {
  const shortKey = new Uint8Array(31)
  try {
    encryptWalletBlob({ mnemonic: 'm', index: 0 }, shortKey)
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('decrypt with non-32-byte key throws InvalidEncryptionKeyError', (t) => {
  const key = new Uint8Array(randomBytes(32))
  const packed = encryptWalletBlob({ mnemonic: 'm', index: 0 }, key)
  const shortKey = new Uint8Array(31)
  try {
    decryptWalletBlob(packed, shortKey)
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('decrypt truncated blob throws InvalidEncryptionKeyError', (t) => {
  const key = new Uint8Array(randomBytes(32))
  const truncated = new Uint8Array(10)
  try {
    decryptWalletBlob(truncated, key)
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('two encryptions of the same blob produce different ciphertexts (random IV)', (t) => {
  const key = new Uint8Array(randomBytes(32))
  const blob = { mnemonic: 'x', index: 0 }
  const a = encryptWalletBlob(blob, key)
  const b = encryptWalletBlob(blob, key)
  t.not(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'))
})
