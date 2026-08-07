import { after } from 'node:test'

import type {
  ChainDB,
  ChainDBConfig,
  WalletDB,
  WalletDBConfig
} from '@railgun-reloaded/storage/node'
import {
  closeChainDB,
  closeWalletDB,
  createChainDB,
  createWalletDB
} from '@railgun-reloaded/storage/node'

/**
 * Databases opened through this module, closed when the file's tests finish.
 * A database left open is finalized during interpreter teardown, which aborts
 * the process rather than failing a test.
 */
const openChainDBs: ChainDB[] = []
const openWalletDBs: WalletDB[] = []

after(async () => {
  const chainDBs = openChainDBs.splice(0)
  const walletDBs = openWalletDBs.splice(0)
  await Promise.all([
    ...chainDBs.map(async (db) => closeChainDB(db)),
    ...walletDBs.map(async (db) => closeWalletDB(db))
  ])
})

/**
 * Open a chain database that closes once the current test file finishes.
 * @param config - Chain database configuration.
 * @returns The open chain database.
 */
async function openChainDB (config: ChainDBConfig): Promise<ChainDB> {
  const db = await createChainDB(config)
  openChainDBs.push(db)
  return db
}

/**
 * Open a wallet database that closes once the current test file finishes.
 * @param config - Wallet database configuration.
 * @returns The open wallet database.
 */
async function openWalletDB (config: WalletDBConfig): Promise<WalletDB> {
  const db = await createWalletDB(config)
  openWalletDBs.push(db)
  return db
}

export { openChainDB, openWalletDB }
