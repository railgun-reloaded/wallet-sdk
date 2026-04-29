import { randomBytes } from 'node:crypto'

import type { EVMBlock } from '@railgun-reloaded/scanner'
import { SourceAggregator } from '@railgun-reloaded/scanner'
import { createChainDB, createWalletDB, getSyncState } from '@railgun-reloaded/storage'
import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'
import { test } from 'brittle'

import { RailgunClient } from '../src/client'
import { NetworkName } from '../src/network-config'

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

test('RailgunClient.scan drains a fake source into chain.db', async (t) => {
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

  t.is(last, 5784867n, 'returns the last block written')
  const cursor = getSyncState(chainDB, 11155111)?.lastBlockHeight
  t.is(cursor, 5784867n, 'sync cursor advanced to tip')

  client.close()
})

test('RailgunClient.decrypt throws when chain DB is uninitialized', async (t) => {
  const walletDB = memDB()
  const client = new RailgunClient({ walletDB })
  const key = new Uint8Array(randomBytes(32))
  await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })

  await t.exception(() => client.decrypt(VECTORS[0]!.walletId, key, { chainId: 11155111 }),
    /chain DB not initialized/)
  client.close()
})

test('RailgunClient.decrypt is a no-op when chain has no commitments', async (t) => {
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
  t.is(summary.walletId, VECTORS[0]!.walletId)
  t.is(summary.chainId, 11155111)
  t.is(summary.notesAdded, 0, 'no commitments to decrypt')
  t.is(summary.notesSpent, 0, 'no nullifiers to match')

  client.close()
})

test('RailgunClient.sync composes scan() then decrypt()', async (t) => {
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

  t.is(summary.scan.lastBlock, 5784867n, 'scan reached the requested tip')
  t.is(summary.decrypt.chainId, 11155111, 'decrypt chainId derived from network')
  t.is(summary.decrypt.notesAdded, 0, 'no commitments → no notes added')
  t.is(summary.decrypt.notesSpent, 0, 'no nullifiers → no notes spent')
  t.is(getSyncState(chainDB, 11155111)?.lastBlockHeight, 5784867n,
    'chain cursor advanced through scan()')

  client.close()
})

test('RailgunClient.sync fires onProgress for both phases in order', async (t) => {
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

  const events: { phase: string, currentBlock: bigint, blocksScanned: bigint }[] = []
  /**
   * Capture each sync progress event for downstream assertions.
   * @param p - Progress event emitted by the SDK.
   * @param p.phase - Either `'scan'` or `'decrypt'`.
   * @param p.currentBlock - Last block of the batch just finished.
   * @param p.blocksScanned - Running total of blocks processed.
   */
  const record = (p: { phase: string, currentBlock: bigint, blocksScanned: bigint }) => {
    events.push({ phase: p.phase, currentBlock: p.currentBlock, blocksScanned: p.blocksScanned })
  }
  await client.sync(VECTORS[0]!.walletId, key, {
    network: NetworkName.EthereumSepolia,
    dataSource: aggregator,
    endBlock: 5784867n,
    onProgress: record
  })

  t.ok(events.length >= 2, 'fired at least once for each phase')
  const phases = events.map(e => e.phase)
  const firstDecrypt = phases.indexOf('decrypt')
  t.not(firstDecrypt, -1, 'decrypt phase emitted')
  t.is(phases.slice(0, firstDecrypt).every(p => p === 'scan'), true,
    'scan events all precede the first decrypt event')

  let monotonic = true
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.phase === events[i - 1]!.phase &&
        events[i]!.currentBlock < events[i - 1]!.currentBlock) {
      monotonic = false
      break
    }
  }
  t.ok(monotonic, 'currentBlock monotonic within each phase')

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
