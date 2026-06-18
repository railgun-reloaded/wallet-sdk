import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { bytesToHex } from '@railgun-reloaded/bytes'
import type { WalletDB } from '@railgun-reloaded/storage'
import { createWalletDB } from '@railgun-reloaded/storage'

import {
  InvalidEncryptionKeyError,
  InvalidMnemonicError,
  WalletAlreadyExistsError,
  WalletNotFoundError
} from '../../../src/services/wallet/errors.js'
import { WalletService } from '../../../src/services/wallet/wallet-service.js'
import { MNEMONIC, VECTORS } from '../../fixtures/wallet-vectors.js'

/**
 * Build a fresh in-memory WalletService and a random 32-byte encryption key.
 * @returns New fixture state per test.
 */
async function fixture (): Promise<{ service: WalletService, db: WalletDB, key: Uint8Array }> {
  const db = await createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
  const service = new WalletService(db)
  const key = new Uint8Array(randomBytes(32))
  return { service, db, key }
}

test('createWallet returns WalletInfo with matching walletId', async () => {
  const { service, key } = await fixture()
  const info = await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  assert.equal(info.walletId, VECTORS[0]!.walletId)
  assert.equal(info.name, null)
  assert.ok(info.createdAt instanceof Date)
})

test('createWallet with a name persists the name', async () => {
  const { service, key } = await fixture()
  const info = await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, name: 'primary' })
  assert.equal(info.name, 'primary')
})

test('createWallet duplicate (mnemonic, index) throws WalletAlreadyExistsError with walletId', async () => {
  const { service, key } = await fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  try {
    await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof WalletAlreadyExistsError)
    assert.equal((err as WalletAlreadyExistsError).walletId, VECTORS[0]!.walletId)
  }
})

test('createWallet same mnemonic, different index => separate wallets', async () => {
  const { service, key } = await fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, index: 0 })
  const info1 = await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, index: 1 })
  assert.equal(info1.walletId, VECTORS[1]!.walletId)
  assert.notEqual(info1.walletId, VECTORS[0]!.walletId)
})

test('createWallet with invalid mnemonic throws InvalidMnemonicError', async () => {
  const { service, key } = await fixture()
  try {
    await service.createWallet({ mnemonic: 'not a valid mnemonic at all', encryptionKey: key })
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof InvalidMnemonicError)
  }
})

test('createWallet with non-32-byte key throws InvalidEncryptionKeyError', async () => {
  const { service } = await fixture()
  try {
    await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: new Uint8Array(31) })
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('loadWallet returns keys matching fixtures', async () => {
  const { service, key } = await fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, name: 'test' })
  const ctx = await service.loadWallet(VECTORS[0]!.walletId, key)
  assert.equal(ctx.walletId, VECTORS[0]!.walletId)
  assert.equal(ctx.name, 'test')
  assert.ok(ctx.railgunAddress.startsWith('0zk1'))
  assert.equal(bytesToHex(ctx.masterPublicKey), VECTORS[0]!.masterPublicKey)
  assert.equal(bytesToHex(ctx.viewingPrivateKey), VECTORS[0]!.viewingPrivateKey)
  assert.equal(bytesToHex(ctx.nullifyingKey), VECTORS[0]!.nullifyingKey)
})

test('loadWallet with unknown id throws WalletNotFoundError', async () => {
  const { service, key } = await fixture()
  try {
    await service.loadWallet('deadbeef'.repeat(8), key)
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof WalletNotFoundError)
  }
})

test('loadWallet with wrong key throws InvalidEncryptionKeyError', async () => {
  const { service, key } = await fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  const wrongKey = new Uint8Array(randomBytes(32))
  try {
    await service.loadWallet(VECTORS[0]!.walletId, wrongKey)
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('listWallets returns wallets sorted by createdAt ASC', async () => {
  const { service, key } = await fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, index: 0 })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, index: 1 })
  const list = await service.listWallets()
  assert.equal(list.length, 2)
  assert.ok(list[0]!.createdAt.getTime() <= list[1]!.createdAt.getTime())
})

test('deleteWallet removes the wallet; second delete is a no-op', async () => {
  const { service, key } = await fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  await service.deleteWallet(VECTORS[0]!.walletId)
  assert.equal((await service.listWallets()).length, 0)
  await service.deleteWallet(VECTORS[0]!.walletId)
  assert.ok(true, 'second delete did not throw')
})

test('full lifecycle: create -> list -> load -> delete -> load throws', async () => {
  const { service, key } = await fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, name: 'primary' })
  assert.equal((await service.listWallets()).length, 1)
  const ctx = await service.loadWallet(VECTORS[0]!.walletId, key)
  assert.equal(ctx.walletId, VECTORS[0]!.walletId)
  await service.deleteWallet(VECTORS[0]!.walletId)
  assert.equal((await service.listWallets()).length, 0)
  try {
    await service.loadWallet(VECTORS[0]!.walletId, key)
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof WalletNotFoundError)
  }
})
