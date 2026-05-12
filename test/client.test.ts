import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import type { EVMBlock } from '@railgun-reloaded/scanner'
import { SourceAggregator } from '@railgun-reloaded/scanner'
import type { DBNewNote, WalletDB } from '@railgun-reloaded/storage'
import {
  createChainDB,
  createWalletDB,
  getSyncState,
  insertNotesBatch,
  recalculateAllBalances
} from '@railgun-reloaded/storage'
import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'

import { RailgunClient, SyncPhase } from '../src/client'
import { NetworkName } from '../src/network-config'
import { WalletNotFoundError } from '../src/services/wallet/errors'

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

/**
 * Build deterministic bytes for note fixtures.
 * @param value - Byte value to fill a 32-byte array with.
 * @returns Filled 32-byte array.
 */
function filledBytes (value: number): Uint8Array {
  return new Uint8Array(32).fill(value)
}

/**
 * Create a storage note fixture with stable defaults.
 * @param overrides - Fields to override on the note.
 * @returns Note row suitable for `insertNotesBatch`.
 */
function noteFixture (overrides: Partial<DBNewNote>): DBNewNote {
  return {
    commitment: filledBytes(1),
    walletId: 'wallet-id',
    nullifier: filledBytes(2),
    token: '0x0000000000000000000000000000000000000000',
    amount: 1n,
    spent: false,
    blockNumber: 1n,
    treeNumber: 0,
    treePosition: 0,
    decryptedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  }
}

/**
 * Seed wallet notes and refresh the cached balances table.
 * @param walletDB - Wallet DB to seed.
 * @param walletId - Existing wallet ID.
 * @param notes - Notes to insert.
 */
function seedNotes (
  walletDB: WalletDB,
  walletId: string,
  notes: DBNewNote[]
): void {
  insertNotesBatch(walletDB, notes.map(note => ({ ...note, walletId })))
  recalculateAllBalances(walletDB, walletId)
}

test('RailgunClient delegates createWallet / listWallets / deleteWallet', async () => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))

  const info = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  assert.equal(info.walletId, VECTORS[0]!.walletId)

  const list = await client.listWallets()
  assert.equal(list.length, 1)

  await client.deleteWallet(info.walletId)
  assert.equal((await client.listWallets()).length, 0)

  client.close()
  assert.ok(true, 'close did not throw')
})

test('RailgunClient close() does not close injected walletDB', async () => {
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  client.close()
  // If close() had closed the injected DB, this query would throw.
  const rows = walletDB.$client.prepare('SELECT 1 as one').all() as { one: number }[]
  assert.equal(rows[0]!.one, 1)
})

test('RailgunClient exposes engine property', async () => {
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  assert.ok(client.engine)
  assert.equal(typeof client.engine.setNetwork, 'function')
  client.close()
})

test('RailgunClient.getBalances returns cached aggregated balances', async () => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const dai = '0x6b175474e89094c44da98b954eedeac495271d0f'

  seedNotes(walletDB, wallet.walletId, [
    noteFixture({ commitment: filledBytes(10), nullifier: filledBytes(11), token: usdc, amount: 100n }),
    noteFixture({ commitment: filledBytes(12), nullifier: filledBytes(13), token: usdc, amount: 200n }),
    noteFixture({ commitment: filledBytes(14), nullifier: filledBytes(15), token: usdc, amount: 50n, spent: true }),
    noteFixture({ commitment: filledBytes(16), nullifier: filledBytes(17), token: dai, amount: 500n })
  ])

  const balances = await client.getBalances(wallet.walletId)
  assert.equal(balances.length, 2)
  assert.equal(balances.find(balance => balance.token === usdc)?.balance, 300n)
  assert.equal(balances.find(balance => balance.token === dai)?.balance, 500n)
  client.close()
})

test('RailgunClient.getBalances omits zero balance rows', async () => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  const token = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

  seedNotes(walletDB, wallet.walletId, [
    noteFixture({
      commitment: filledBytes(18),
      nullifier: filledBytes(19),
      token,
      amount: 100n,
      spent: true
    })
  ])

  assert.deepEqual(await client.getBalances(wallet.walletId), [])
  assert.equal(await client.getTokenBalance(wallet.walletId, token), 0n)
  client.close()
})

test('RailgunClient balance API returns empty values for an empty wallet', async () => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })

  assert.deepEqual(await client.getBalances(wallet.walletId), [])
  assert.equal(await client.getTokenBalance(wallet.walletId, '0x0000000000000000000000000000000000000000'), 0n)
  assert.deepEqual(await client.getNotes(wallet.walletId), [])
  client.close()
})

test('RailgunClient.getTokenBalance lowercases token input', async () => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  const token = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

  seedNotes(walletDB, wallet.walletId, [
    noteFixture({ commitment: filledBytes(20), nullifier: filledBytes(21), token, amount: 123n })
  ])

  assert.equal(await client.getTokenBalance(wallet.walletId, token.toUpperCase()), 123n)
  assert.equal(await client.getTokenBalance(wallet.walletId, '0x1111111111111111111111111111111111111111'), 0n)
  client.close()
})

test('RailgunClient.getNotes maps all and unspent notes', async () => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  const token = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const tokenMixed = '0xA0b86991C6218b36c1d19D4a2e9Eb0cE3606eB48'
  const spentTxid = filledBytes(33)

  seedNotes(walletDB, wallet.walletId, [
    noteFixture({
      commitment: filledBytes(30),
      nullifier: filledBytes(31),
      token: tokenMixed,
      amount: 10n,
      blockNumber: 100n,
      treeNumber: 2,
      treePosition: 7,
      decryptedAt: new Date('2026-02-03T04:05:06.000Z')
    }),
    noteFixture({
      commitment: filledBytes(32),
      nullifier: filledBytes(34),
      token: tokenMixed,
      amount: 20n,
      spent: true,
      spentTxid
    })
  ])

  const all = await client.getNotes(wallet.walletId)
  const unspent = await client.getNotes(wallet.walletId, { unspent: true })
  const allExplicit = await client.getNotes(wallet.walletId, { unspent: false })
  const first = all.find(note => note.amount === 10n)
  const spent = all.find(note => note.spent)

  assert.equal(all.length, 2, 'default returns all notes')
  assert.equal(allExplicit.length, 2, 'unspent false returns all notes')
  assert.equal(unspent.length, 1, 'unspent true excludes spent notes')
  assert.ok(first)
  assert.equal(first?.commitment, `0x${'1e'.repeat(32)}`)
  assert.equal(first?.nullifier, `0x${'1f'.repeat(32)}`)
  assert.equal(first?.token, token)
  assert.equal(first?.leafIndex, 7n)
  assert.equal(first?.decryptedAt.toISOString(), '2026-02-03T04:05:06.000Z')
  assert.equal(spent?.spentTxid, `0x${'21'.repeat(32)}`)
  client.close()
})

test('RailgunClient balance API throws WalletNotFoundError for unknown wallet', async () => {
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const unknown = 'missing-wallet'

  for (const action of [
    () => client.getBalances(unknown),
    () => client.getTokenBalance(unknown, '0x0000000000000000000000000000000000000000'),
    () => client.getNotes(unknown)
  ]) {
    try {
      await action()
      assert.fail('expected WalletNotFoundError')
    } catch (err: unknown) {
      assert.ok(err instanceof WalletNotFoundError)
      if (err instanceof WalletNotFoundError) {
        assert.equal(err.walletId, unknown)
      }
    }
  }

  client.close()
})

/**
 * Build a minimal in-memory chain DB (created via storage's drizzle migrator).
 * @returns Fresh ChainDB suitable for client.scan() injection.
 */
function memChainDB () {
  return createChainDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/chain'
  })
}

/**
 * Minimal DataSource fake that yields a fixed block list once. `head()`
 * resolves to the highest yielded block so the aggregator treats it as a
 * non-live, drain-to-tip source.
 */
class FakeSource {
  /** Required by DataSource — non-live so the aggregator drains to its head. */
  isLiveProvider = false
  /** Buffered blocks to replay. */
  readonly #blocks: EVMBlock[]

  /**
   * Construct a fake source.
   * @param blocks - Blocks to yield in order; assumed sorted by `number`.
   */
  constructor (blocks: EVMBlock[]) {
    this.#blocks = blocks
  }

  /**
   * Last block this source can serve.
   * @returns Highest block number, or 0n when no blocks are buffered.
   */
  async head () {
    return this.#blocks.length === 0
      ? 0n
      : this.#blocks[this.#blocks.length - 1]!.number
  }

  /**
   * Yield buffered blocks within `[startHeight, endHeight]`.
   * @param options - Standard SyncOptions subset.
   * @param options.startHeight - Inclusive lower bound on block number.
   * @param options.endHeight - Inclusive upper bound; unbounded when omitted.
   * @yields Blocks in ascending order.
   */
  async * from (options: { startHeight: bigint, endHeight?: bigint | undefined }): AsyncGenerator<EVMBlock> {
    for (const block of this.#blocks) {
      if (block.number < options.startHeight) continue
      if (options.endHeight !== undefined && block.number > options.endHeight) break
      yield block
    }
  }

  /** No-op for the fake; required by the DataSource shape. */
  destroy () {}
}

test('RailgunClient.scan drains a fake source into chain.db', async () => {
  const walletDB = memDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  const blocks: EVMBlock[] = [
    { number: 5784866n, hash: new Uint8Array(32), timestamp: 0n, transactions: [] },
    { number: 5784867n, hash: new Uint8Array(32), timestamp: 0n, transactions: [] }
  ]
  const aggregator = new SourceAggregator<EVMBlock>([new FakeSource(blocks)])

  const last = await client.scan({
    network: NetworkName.EthereumSepolia,
    dataSource: aggregator,
    endBlock: 5784867n
  })

  assert.equal(last, 5784867n, 'returns the last block written')
  const cursor = getSyncState(chainDB, 11155111)?.lastBlockHeight
  assert.equal(cursor, 5784867n, 'sync cursor advanced to tip')

  client.close()
})

test('RailgunClient.decrypt throws when chain DB is uninitialized', async () => {
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))
  await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })

  await assert.rejects(() => client.decrypt(VECTORS[0]!.walletId, key, { chainId: 11155111 }),
    /chain DB not initialized/)
  client.close()
})

test('RailgunClient.decrypt is a no-op when chain has no commitments', async () => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })
  const key = new Uint8Array(randomBytes(32))
  await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })

  // Empty chain: scan() drains a source with no blocks; chain.syncState ends up
  // at undefined, so decrypt() should resolve to a zero-summary without error.
  await client.scan({
    network: NetworkName.EthereumSepolia,
    dataSource: new SourceAggregator<EVMBlock>([new FakeSource([
      { number: 5784866n, hash: new Uint8Array(32), timestamp: 0n, transactions: [] }
    ])]),
    endBlock: 5784866n
  })

  const summary = await client.decrypt(VECTORS[0]!.walletId, key, { chainId: 11155111 })
  assert.equal(summary.walletId, VECTORS[0]!.walletId)
  assert.equal(summary.chainId, 11155111)
  assert.equal(summary.notesAdded, 0, 'no commitments to decrypt')
  assert.equal(summary.notesSpent, 0, 'no nullifiers to match')

  client.close()
})

test('RailgunClient.sync composes scan() then decrypt()', async () => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })
  const key = new Uint8Array(randomBytes(32))
  await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })

  const blocks: EVMBlock[] = [
    { number: 5784866n, hash: new Uint8Array(32), timestamp: 0n, transactions: [] },
    { number: 5784867n, hash: new Uint8Array(32), timestamp: 0n, transactions: [] }
  ]
  const aggregator = new SourceAggregator<EVMBlock>([new FakeSource(blocks)])

  const summary = await client.sync(VECTORS[0]!.walletId, key, {
    network: NetworkName.EthereumSepolia,
    dataSource: aggregator,
    endBlock: 5784867n
  })

  assert.equal(summary.scan.lastBlock, 5784867n, 'scan reached the requested tip')
  assert.equal(summary.decrypt.chainId, 11155111, 'decrypt chainId derived from network')
  assert.equal(summary.decrypt.notesAdded, 0, 'no commitments → no notes added')
  assert.equal(summary.decrypt.notesSpent, 0, 'no nullifiers → no notes spent')
  assert.equal(getSyncState(chainDB, 11155111)?.lastBlockHeight, 5784867n,
    'chain cursor advanced through scan()')

  client.close()
})

test('RailgunClient.sync fires onProgress for both phases in order', async () => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })
  const key = new Uint8Array(randomBytes(32))
  await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })

  const blocks: EVMBlock[] = [
    { number: 5784866n, hash: new Uint8Array(32), timestamp: 0n, transactions: [] },
    { number: 5784867n, hash: new Uint8Array(32), timestamp: 0n, transactions: [] }
  ]
  const aggregator = new SourceAggregator<EVMBlock>([new FakeSource(blocks)])

  const events: { phase: SyncPhase, currentBlock: bigint, blocksScanned: bigint }[] = []
  /**
   * Capture each sync progress event for downstream assertions.
   * @param p - Progress event emitted by the SDK.
   * @param p.phase - `SyncPhase` value for the emitted phase.
   * @param p.currentBlock - Last block of the batch just finished.
   * @param p.blocksScanned - Running total of blocks processed.
   */
  const record = (p: { phase: SyncPhase, currentBlock: bigint, blocksScanned: bigint }) => {
    events.push({ phase: p.phase, currentBlock: p.currentBlock, blocksScanned: p.blocksScanned })
  }
  await client.sync(VECTORS[0]!.walletId, key, {
    network: NetworkName.EthereumSepolia,
    dataSource: aggregator,
    endBlock: 5784867n,
    onProgress: record
  })

  assert.ok(events.length >= 2, 'fired at least once for each phase')
  const phases = events.map(e => e.phase)
  const firstDecrypt = phases.indexOf(SyncPhase.Decrypt)
  assert.notEqual(firstDecrypt, -1, 'decrypt phase emitted')
  assert.equal(phases.slice(0, firstDecrypt).every(p => p === SyncPhase.Scan), true,
    'scan events all precede the first decrypt event')

  let monotonic = true
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.phase === events[i - 1]!.phase &&
        events[i]!.currentBlock < events[i - 1]!.currentBlock) {
      monotonic = false
      break
    }
  }
  assert.ok(monotonic, 'currentBlock monotonic within each phase')

  client.close()
})

test('RailgunClient loadWallet returns correct keys', async () => {
  await initializeCryptographyLibs()
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))

  await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key, name: 'primary' })
  const ctx = await client.loadWallet(VECTORS[0]!.walletId, key)

  assert.equal(ctx.walletId, VECTORS[0]!.walletId)
  assert.equal(ctx.name, 'primary')
  assert.ok(ctx.railgunAddress.startsWith('0zk1'))

  client.close()
})
