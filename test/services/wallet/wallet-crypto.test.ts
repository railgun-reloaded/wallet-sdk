import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { InvalidEncryptionKeyError } from '../../../src/services/wallet/errors'
import {
  decryptWalletBlob,
  encryptWalletBlob
} from '../../../src/services/wallet/wallet-crypto'
import { MNEMONIC } from '../../fixtures/wallet-vectors'

test('encrypt / decrypt round-trip returns the same blob', () => {
  const key = new Uint8Array(randomBytes(32))
  const blob = {
    mnemonic: MNEMONIC,
    index: 0
  }
  const packed = encryptWalletBlob(blob, key)
  const decrypted = decryptWalletBlob(packed, key)
  assert.equal(decrypted.mnemonic, blob.mnemonic)
  assert.equal(decrypted.index, blob.index)
})

test('decrypt with wrong key throws InvalidEncryptionKeyError', () => {
  const key = new Uint8Array(randomBytes(32))
  const wrongKey = new Uint8Array(randomBytes(32))
  const packed = encryptWalletBlob({ mnemonic: 'm', index: 0 }, key)
  try {
    decryptWalletBlob(packed, wrongKey)
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('decrypt of tampered ciphertext throws InvalidEncryptionKeyError', () => {
  const key = new Uint8Array(randomBytes(32))
  const packed = encryptWalletBlob({ mnemonic: 'm', index: 0 }, key)
  packed[packed.length - 1]! ^= 0xff
  try {
    decryptWalletBlob(packed, key)
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('encrypt with non-32-byte key throws InvalidEncryptionKeyError', () => {
  const shortKey = new Uint8Array(31)
  try {
    encryptWalletBlob({ mnemonic: 'm', index: 0 }, shortKey)
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('decrypt with non-32-byte key throws InvalidEncryptionKeyError', () => {
  const key = new Uint8Array(randomBytes(32))
  const packed = encryptWalletBlob({ mnemonic: 'm', index: 0 }, key)
  const shortKey = new Uint8Array(31)
  try {
    decryptWalletBlob(packed, shortKey)
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('decrypt truncated blob throws InvalidEncryptionKeyError', () => {
  const key = new Uint8Array(randomBytes(32))
  const truncated = new Uint8Array(10)
  try {
    decryptWalletBlob(truncated, key)
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('two encryptions of the same blob produce different ciphertexts (random IV)', () => {
  const key = new Uint8Array(randomBytes(32))
  const blob = { mnemonic: 'x', index: 0 }
  const a = encryptWalletBlob(blob, key)
  const b = encryptWalletBlob(blob, key)
  assert.notEqual(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'))
})
