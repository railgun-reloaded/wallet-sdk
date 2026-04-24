import { randomBytes } from 'node:crypto'

import { createWalletDB } from '@railgun-reloaded/storage'
import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'
import { test } from 'brittle'

import { RailgunClient } from '../src/client'

import { MNEMONIC, VECTORS } from './fixtures/wallet-vectors'

/**
 * Build a fresh in-memory WalletDB for a RailgunClient test.
 * @returns New drizzle-wrapped in-memory SQLite.
 */
function memDB () {
  return createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
}

test('RailgunClient delegates createWallet / listWallets / deleteWallet', async (t) => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))

  const info = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  t.is(info.walletId, VECTORS[0]!.walletId)

  const list = await client.listWallets()
  t.is(list.length, 1)

  await client.deleteWallet(info.walletId)
  t.is((await client.listWallets()).length, 0)

  client.close()
  t.pass('close did not throw')
})

test('RailgunClient close() does not close injected walletDB', async (t) => {
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  client.close()
  // If close() had closed the injected DB, this query would throw.
  const rows = walletDB.$client.prepare('SELECT 1 as one').all() as { one: number }[]
  t.is(rows[0]!.one, 1)
})

test('RailgunClient exposes engine property', async (t) => {
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  t.ok(client.engine)
  t.is(typeof client.engine.setNetwork, 'function')
  client.close()
})

test('RailgunClient loadWallet returns correct keys', async (t) => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))

  await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, name: 'primary' })
  const ctx = await client.loadWallet(VECTORS[0]!.walletId, key)

  t.is(ctx.walletId, VECTORS[0]!.walletId)
  t.is(ctx.name, 'primary')
  t.ok(ctx.railgunAddress.startsWith('0zk1'))

  client.close()
})
