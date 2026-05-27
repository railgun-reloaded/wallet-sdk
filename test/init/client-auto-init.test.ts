import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import type { WalletDB } from '@railgun-reloaded/storage'
import { createWalletDB } from '@railgun-reloaded/storage'

import { RailgunClient } from '../../src/client'
import { MNEMONIC, VECTORS } from '../fixtures/wallet-vectors'

/**
 * Build a fresh in-memory WalletDB for a RailgunClient test. Mirrors the
 * helper used in `client.test.ts` and `wallet-service.test.ts`.
 * @returns Drizzle-wrapped in-memory SQLite.
 */
function memDB (): WalletDB {
  return createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
}

test('createWallet auto-initializes cryptography without a manual init call', async () => {
  const client = new RailgunClient({ walletDB: memDB() })
  try {
    const key = new Uint8Array(randomBytes(32))
    const info = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
    assert.equal(info.walletId, VECTORS[0]!.walletId)
  } finally {
    client.close()
  }
})

test('loadWallet auto-initializes cryptography without a manual init call', async () => {
  const client = new RailgunClient({ walletDB: memDB() })
  try {
    const key = new Uint8Array(randomBytes(32))
    await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
    const ctx = await client.loadWallet(VECTORS[0]!.walletId, key)
    assert.equal(ctx.walletId, VECTORS[0]!.walletId)
    assert.ok(ctx.railgunAddress.startsWith('0zk1'))
  } finally {
    client.close()
  }
})

test('client.initialize() is idempotent across multiple RailgunClient instances', async () => {
  const clientA = new RailgunClient({ walletDB: memDB() })
  const clientB = new RailgunClient({ walletDB: memDB() })
  try {
    const pA = clientA.initialize()
    const pB = clientB.initialize()
    assert.equal(pA, pB)
    await Promise.all([pA, pB])
  } finally {
    clientA.close()
    clientB.close()
  }
})
