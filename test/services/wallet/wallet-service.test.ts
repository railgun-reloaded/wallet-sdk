import { randomBytes } from 'node:crypto'

import type { WalletDB } from '@railgun-reloaded/storage'
import { createWalletDB } from '@railgun-reloaded/storage'
import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'
import { test } from 'brittle'

import {
  InvalidEncryptionKeyError,
  InvalidMnemonicError,
  WalletAlreadyExistsError,
  WalletNotFoundError
} from '../../../src/services/wallet/errors'
import { WalletService } from '../../../src/services/wallet/wallet-service'
import { MNEMONIC, VECTORS } from '../../fixtures/wallet-vectors'

/**
 * Encode bytes as unprefixed lowercase hex for fixture comparison.
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

/**
 * Build a fresh in-memory WalletService and a random 32-byte encryption key.
 * @returns New fixture state per test.
 */
function fixture (): { service: WalletService, db: WalletDB, key: Uint8Array } {
  const db = createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
  const service = new WalletService(db)
  const key = new Uint8Array(randomBytes(32))
  return { service, db, key }
}

test('createWallet returns WalletInfo with matching walletId', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  const info = await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  t.is(info.walletId, VECTORS[0]!.walletId)
  t.is(info.name, null)
  t.ok(info.createdAt instanceof Date)
})

test('createWallet with a name persists the name', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  const info = await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, name: 'primary' })
  t.is(info.name, 'primary')
})

test('createWallet duplicate (mnemonic, index) throws WalletAlreadyExistsError with walletId', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  try {
    await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof WalletAlreadyExistsError)
    t.is((err as WalletAlreadyExistsError).walletId, VECTORS[0]!.walletId)
  }
})

test('createWallet same mnemonic, different index => separate wallets', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, index: 0 })
  const info1 = await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, index: 1 })
  t.is(info1.walletId, VECTORS[1]!.walletId)
  t.not(info1.walletId, VECTORS[0]!.walletId)
})

test('createWallet with invalid mnemonic throws InvalidMnemonicError', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  try {
    await service.createWallet({ mnemonic: 'not a valid mnemonic at all', encryptionKey: key })
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof InvalidMnemonicError)
  }
})

test('createWallet with non-32-byte key throws InvalidEncryptionKeyError', async (t) => {
  await initializeCryptographyLibs()
  const { service } = fixture()
  try {
    await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: new Uint8Array(31) })
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('loadWallet returns keys matching fixtures', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, name: 'test' })
  const ctx = await service.loadWallet(VECTORS[0]!.walletId, key)
  t.is(ctx.walletId, VECTORS[0]!.walletId)
  t.is(ctx.name, 'test')
  t.ok(ctx.railgunAddress.startsWith('0zk1'))
  t.is(toHex(ctx.masterPublicKey), VECTORS[0]!.masterPublicKey)
  t.is(toHex(ctx.viewingPrivateKey), VECTORS[0]!.viewingPrivateKey)
  t.is(toHex(ctx.nullifyingKey), VECTORS[0]!.nullifyingKey)
})

test('loadWallet with unknown id throws WalletNotFoundError', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  try {
    await service.loadWallet('deadbeef'.repeat(8), key)
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof WalletNotFoundError)
  }
})

test('loadWallet with wrong key throws InvalidEncryptionKeyError', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  const wrongKey = new Uint8Array(randomBytes(32))
  try {
    await service.loadWallet(VECTORS[0]!.walletId, wrongKey)
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof InvalidEncryptionKeyError)
  }
})

test('listWallets returns wallets sorted by createdAt ASC', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, index: 0 })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, index: 1 })
  const list = await service.listWallets()
  t.is(list.length, 2)
  t.ok(list[0]!.createdAt.getTime() <= list[1]!.createdAt.getTime())
})

test('deleteWallet removes the wallet; second delete is a no-op', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  await service.deleteWallet(VECTORS[0]!.walletId)
  t.is((await service.listWallets()).length, 0)
  await service.deleteWallet(VECTORS[0]!.walletId)
  t.pass('second delete did not throw')
})

test('full lifecycle: create -> list -> load -> delete -> load throws', async (t) => {
  await initializeCryptographyLibs()
  const { service, key } = fixture()
  await service.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, name: 'primary' })
  t.is((await service.listWallets()).length, 1)
  const ctx = await service.loadWallet(VECTORS[0]!.walletId, key)
  t.is(ctx.walletId, VECTORS[0]!.walletId)
  await service.deleteWallet(VECTORS[0]!.walletId)
  t.is((await service.listWallets()).length, 0)
  try {
    await service.loadWallet(VECTORS[0]!.walletId, key)
    t.fail('expected throw')
  } catch (err) {
    t.ok(err instanceof WalletNotFoundError)
  }
})
