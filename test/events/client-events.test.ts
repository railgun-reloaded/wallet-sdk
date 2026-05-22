import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import type { EVMBlock } from '@railgun-reloaded/scanner'
import { SourceAggregator } from '@railgun-reloaded/scanner'
import type {
  ChainDB,
  DBNewNote,
  DBNewNullifier,
  WalletDB
} from '@railgun-reloaded/storage'
import {
  createChainDB,
  createWalletDB,
  insertNotesBatch,
  insertNullifiersBatch,
  recalculateAllBalances,
  updateSyncState
} from '@railgun-reloaded/storage'
import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'

import { RailgunClient } from '../../src/client'
import { NetworkName } from '../../src/network-config'
import { MNEMONIC } from '../fixtures/wallet-vectors'
import { TEST_VECTOR_TRANSACT } from '../test-vector'

const SEPOLIA_CHAIN_ID = 11155111
const SEPOLIA_DEPLOYMENT_BLOCK = 5784866n
const TOKEN = '0x0000000000000000000000000000000000000000'

/**
 * In-memory wallet DB with migrations applied.
 * @returns Fresh wallet DB.
 */
function memWalletDB () {
  return createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
}

/**
 * In-memory chain DB with migrations applied.
 * @returns Fresh chain DB.
 */
function memChainDB () {
  return createChainDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/chain'
  })
}

/**
 * Minimal data source fake for scan/sync event tests.
 */
class FakeSource {
  /** Required by SourceAggregator to treat this as finite history. */
  isLiveProvider = false
  /** Buffered blocks to replay. */
  readonly #blocks: EVMBlock[]
  /** Optional source head when no blocks are yielded. */
  readonly #headHeight: bigint | undefined

  /**
   * Construct a fake source.
   * @param blocks - Blocks to yield in ascending order.
   * @param headHeight - Optional source head override.
   */
  constructor (blocks: EVMBlock[], headHeight?: bigint) {
    this.#blocks = blocks
    this.#headHeight = headHeight
  }

  /**
   * Report the source tip.
   * @returns Highest buffered block, or 0n for empty sources.
   */
  async head () {
    if (this.#headHeight !== undefined) {
      return this.#headHeight
    }
    return this.#blocks.length === 0
      ? 0n
      : this.#blocks[this.#blocks.length - 1]!.number
  }

  /**
   * Yield buffered blocks inside the requested range.
   * @param options - Block range.
   * @param options.startHeight - Inclusive start height.
   * @param options.endHeight - Optional inclusive end height.
   * @yields Buffered blocks inside the requested range.
   */
  async * from (options: { startHeight: bigint, endHeight?: bigint | undefined }): AsyncGenerator<EVMBlock> {
    for (const block of this.#blocks) {
      if (block.number < options.startHeight) continue
      if (options.endHeight !== undefined && block.number > options.endHeight) break
      yield block
    }
  }

  /** No-op for tests. */
  destroy () {}
}

/**
 * Source that fails after scan starts, used to assert sync:error emission.
 */
class FailingSource {
  /** Required by SourceAggregator to treat this as finite history. */
  isLiveProvider = false
  /** Error thrown from iteration. */
  readonly #error: Error

  /**
   * Construct a failing source.
   * @param error - Error to throw while iterating.
   */
  constructor (error: Error) {
    this.#error = error
  }

  /**
   * Report a finite source tip.
   * @returns Sepolia deployment block.
   */
  async head () {
    return SEPOLIA_DEPLOYMENT_BLOCK
  }

  /**
   * Fail during iteration.
   */
  async * from (): AsyncGenerator<EVMBlock> {
    throw this.#error
  }

  /** No-op for tests. */
  destroy () {}
}

/**
 * Stable byte fixture.
 * @param value - Byte value to repeat.
 * @returns 32-byte array.
 */
function filledBytes (value: number): Uint8Array {
  return new Uint8Array(32).fill(value)
}

/**
 * Create a note row with stable defaults.
 * @param walletId - Owning wallet ID.
 * @param overrides - Fields to override.
 * @returns New note row.
 */
function noteFixture (
  walletId: string,
  overrides: Partial<DBNewNote> = {}
): DBNewNote {
  return {
    commitment: filledBytes(1),
    walletId,
    nullifier: filledBytes(2),
    token: TOKEN,
    amount: 5n,
    spent: false,
    blockNumber: 1n,
    treeNumber: 0,
    treePosition: 0,
    decryptedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  }
}

/**
 * Seed wallet notes and refresh cached balances.
 * @param walletDB - Wallet database.
 * @param walletId - Owning wallet ID.
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

/**
 * Seed one matching chain nullifier so decrypt marks an owned note spent.
 * @param chainDB - Chain database.
 * @param nullifier - Owned note nullifier.
 * @param blockNumber - Block carrying the nullifier.
 */
function seedChainNullifier (
  chainDB: ChainDB,
  nullifier: Uint8Array,
  blockNumber: bigint
): void {
  const row: DBNewNullifier = {
    nullifier,
    transactionHash: filledBytes(90),
    blockNumber,
    treeNumber: 0
  }
  insertNullifiersBatch(chainDB, [row])
  updateSyncState(chainDB, SEPOLIA_CHAIN_ID, blockNumber)
}

/**
 * Small finite scan source over Sepolia's deployment range.
 * @returns SourceAggregator with two empty blocks.
 */
function fakeSepoliaSource (): SourceAggregator<EVMBlock> {
  return new SourceAggregator<EVMBlock>([new FakeSource([
    { number: SEPOLIA_DEPLOYMENT_BLOCK, hash: new Uint8Array(32), timestamp: 0n, transactions: [] },
    { number: SEPOLIA_DEPLOYMENT_BLOCK + 1n, hash: new Uint8Array(32), timestamp: 0n, transactions: [] }
  ])])
}

test('decrypt() emits sync:start then sync:complete; no balance:update on no-op', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })

  const events: string[] = []
  client.on('sync:start', (e) => events.push(`start:${e.phase}`))
  client.on('sync:progress', (e) => events.push(`progress:${e.phase}`))
  client.on('sync:complete', (e) => events.push(`complete:${e.phase}`))
  client.on('balance:update', () => events.push('balance'))

  await client.decrypt(wallet.walletId, encryptionKey, {
    chainId: SEPOLIA_CHAIN_ID,
    fromBlock: 0n,
    toBlock: 0n
  })

  assert.ok(events.includes('start:decrypt'), 'sync:start fired')
  assert.ok(events.includes('progress:decrypt'), 'sync:progress fired')
  assert.ok(events.includes('complete:decrypt'), 'sync:complete fired')
  assert.ok(!events.includes('balance'), 'balance:update suppressed when no notes changed')

  client.close()
})

test('decrypt no-op suppresses balance:update even with cached balances', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })
  seedNotes(walletDB, wallet.walletId, [noteFixture(wallet.walletId)])

  const balanceEvents: number[] = []
  client.on('balance:update', (e) => balanceEvents.push(e.balances.length))

  await client.decrypt(wallet.walletId, encryptionKey, {
    chainId: SEPOLIA_CHAIN_ID,
    fromBlock: 0n,
    toBlock: 0n
  })

  assert.equal(balanceEvents.length, 0, 'pre-existing balances do not trigger the event')
  client.close()
})

test('balance:update fires with a fresh snapshot when decrypt marks a note spent', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })
  const spentNullifier = filledBytes(12)
  seedNotes(walletDB, wallet.walletId, [
    noteFixture(wallet.walletId, {
      commitment: filledBytes(11),
      nullifier: spentNullifier,
      amount: 5n
    }),
    noteFixture(wallet.walletId, {
      commitment: filledBytes(13),
      nullifier: filledBytes(14),
      amount: 7n
    })
  ])
  seedChainNullifier(chainDB, spentNullifier, 1n)

  const balanceEvents: Array<{ spent: number, len: number, balance: bigint | undefined }> = []
  client.on('balance:update', (e) => balanceEvents.push({
    spent: e.notesSpent,
    len: e.balances.length,
    balance: e.balances[0]?.balance
  }))

  const summary = await client.decrypt(wallet.walletId, encryptionKey, {
    chainId: SEPOLIA_CHAIN_ID,
    fromBlock: 1n,
    toBlock: 1n
  })

  assert.equal(summary.notesSpent, 1, 'decrypt marked the owned note spent')
  assert.equal(balanceEvents.length, 1, 'one balance:update per decrypt run')
  assert.equal(balanceEvents[0]!.spent, 1, 'notesSpent reflected in event')
  assert.equal(balanceEvents[0]!.len, 1, 'snapshot contains remaining positive balance')
  assert.equal(balanceEvents[0]!.balance, 7n, 'snapshot was read after recompute')
  client.close()
})

test('balance:update fires with a fresh snapshot when decrypt adds notes', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })
  const order: string[] = []
  const balanceEvents: Array<{ added: number, len: number, walletId: string }> = []
  client.on('sync:start', (e) => order.push(`start:${e.phase}`))
  client.on('balance:update', (e) => {
    order.push('balance')
    balanceEvents.push({
      added: e.notesAdded,
      len: e.balances.length,
      walletId: e.walletId
    })
  })
  client.on('sync:complete', (e) => order.push(`complete:${e.phase}`))

  await client.scan({
    network: NetworkName.EthereumSepolia,
    dataSource: new SourceAggregator<EVMBlock>([
      new FakeSource([TEST_VECTOR_TRANSACT])
    ]),
    endBlock: TEST_VECTOR_TRANSACT.number
  })
  const summary = await client.decrypt(wallet.walletId, encryptionKey, {
    chainId: SEPOLIA_CHAIN_ID,
    fromBlock: TEST_VECTOR_TRANSACT.number,
    toBlock: TEST_VECTOR_TRANSACT.number
  })

  assert.ok(summary.notesAdded >= 1, 'decrypt found a note')
  assert.equal(balanceEvents.length, 1, 'one balance:update per decrypt run')
  assert.ok(balanceEvents[0]!.added >= 1, 'notesAdded reflected in event')
  assert.ok(balanceEvents[0]!.len >= 1, 'snapshot non-empty')
  assert.equal(balanceEvents[0]!.walletId, wallet.walletId, 'event scoped to wallet')
  assert.ok(
    order.indexOf('balance') < order.lastIndexOf('complete:decrypt'),
    'balance:update fired before decrypt complete'
  )
  client.close()
})

test('scan() emits sync:start, sync:progress, sync:complete', async () => {
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  const events: Array<{ name: string, phase?: string }> = []
  client.on('sync:start', (e) => events.push({ name: 'start', phase: e.phase }))
  client.on('sync:progress', (e) => events.push({ name: 'progress', phase: e.phase }))
  client.on('sync:complete', (e) => events.push({ name: 'complete', phase: e.phase }))

  await client.scan({
    network: NetworkName.EthereumSepolia,
    dataSource: fakeSepoliaSource(),
    endBlock: SEPOLIA_DEPLOYMENT_BLOCK + 1n
  })

  assert.ok(events.find(e => e.name === 'start' && e.phase === 'scan'), 'scan start fired')
  assert.ok(events.find(e => e.name === 'progress' && e.phase === 'scan'), 'scan progress fired')
  assert.ok(events.find(e => e.name === 'complete' && e.phase === 'scan'), 'scan complete fired')
  client.close()
})

test('scan() complete reports covered blocks even when no event blocks yield', async () => {
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  let startFrom: bigint | undefined
  let completeBlocks: bigint | undefined
  client.on('sync:start', (e) => { startFrom = e.fromBlock })
  client.on('sync:progress', () => { throw new Error('unexpected progress') })
  client.on('sync:complete', (e) => { completeBlocks = e.blocksScanned })

  await client.scan({
    network: NetworkName.EthereumSepolia,
    dataSource: new SourceAggregator<EVMBlock>([
      new FakeSource([], SEPOLIA_DEPLOYMENT_BLOCK + 1n)
    ]),
    endBlock: SEPOLIA_DEPLOYMENT_BLOCK + 1n
  })

  assert.equal(startFrom, SEPOLIA_DEPLOYMENT_BLOCK, 'scan start reports resolved fromBlock')
  assert.equal(completeBlocks, 2n, 'complete reports covered empty range')
  client.close()
})

test('every sync:progress emitted by decrypt() carries phase=decrypt', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })

  const phases: string[] = []
  client.on('sync:progress', (e) => phases.push(e.phase))

  await client.decrypt(wallet.walletId, encryptionKey, {
    chainId: SEPOLIA_CHAIN_ID,
    fromBlock: 0n,
    toBlock: 0n
  })

  assert.ok(phases.length > 0, 'decrypt emitted progress')
  assert.ok(phases.every(p => p === 'decrypt'), 'all progress events tagged decrypt')
  client.close()
})

test('sync() emits all three start/complete pairs', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })

  const phases: string[] = []
  client.on('sync:start', (e) => phases.push(`start:${e.phase}`))
  client.on('sync:complete', (e) => phases.push(`complete:${e.phase}`))

  await client.sync(wallet.walletId, encryptionKey, {
    network: NetworkName.EthereumSepolia,
    dataSource: fakeSepoliaSource(),
    endBlock: SEPOLIA_DEPLOYMENT_BLOCK + 1n,
    fromBlock: SEPOLIA_DEPLOYMENT_BLOCK,
    toBlock: SEPOLIA_DEPLOYMENT_BLOCK + 1n
  })

  assert.ok(phases.includes('start:sync'), 'outer sync:start fired')
  assert.ok(phases.includes('start:scan'), 'inner scan start fired')
  assert.ok(phases.includes('start:decrypt'), 'inner decrypt start fired')
  assert.ok(phases.includes('complete:scan'), 'inner scan complete fired')
  assert.ok(phases.includes('complete:decrypt'), 'inner decrypt complete fired')
  assert.ok(phases.includes('complete:sync'), 'outer sync:complete fired')
  client.close()
})

test('argument-validation throws happen before bus emission', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const client = new RailgunClient({ walletDB })
  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })

  const events: string[] = []
  client.on('sync:start', () => events.push('start'))
  client.on('sync:error', () => events.push('error'))

  await assert.rejects(
    () => client.decrypt(wallet.walletId, encryptionKey, { chainId: SEPOLIA_CHAIN_ID }),
    /chain DB not initialized/
  )

  assert.ok(!events.includes('start'), 'pre-bus validation did not emit start')
  assert.ok(!events.includes('error'), 'pre-bus validation did not emit error')
  client.close()
})

test('scan() emits sync:error before rethrow and suppresses complete', async () => {
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })
  const events: string[] = []

  client.on('sync:start', (e) => events.push(`start:${e.phase}`))
  client.on('sync:error', (e) => events.push(`error:${e.phase}:${e.error.message}`))
  client.on('sync:complete', (e) => events.push(`complete:${e.phase}`))

  await assert.rejects(
    () => client.scan({
      network: NetworkName.EthereumSepolia,
      dataSource: new SourceAggregator<EVMBlock>([
        new FailingSource(new Error('source boom'))
      ]),
      endBlock: SEPOLIA_DEPLOYMENT_BLOCK
    }),
    /source boom/
  )

  assert.deepEqual(events, ['start:scan', 'error:scan:source boom'])
  client.close()
})

test('decrypt() emits sync:error before rethrow and suppresses complete', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })
  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })
  const events: string[] = []

  client.on('sync:start', (e) => events.push(`start:${e.phase}`))
  client.on('sync:error', (e) => events.push(`error:${e.phase}:${e.error.message}`))
  client.on('sync:complete', (e) => events.push(`complete:${e.phase}`))

  await assert.rejects(
    () => client.decrypt(wallet.walletId, encryptionKey, {
      chainId: SEPOLIA_CHAIN_ID,
      fromBlock: 0n,
      toBlock: 0n,
      /**
       * Throw from the existing per-call callback so decrypt enters its
       * post-start error path.
       */
      onProgress: () => { throw new Error('progress boom') }
    }),
    /progress boom/
  )

  assert.deepEqual(events, ['start:decrypt', 'error:decrypt:progress boom'])
  client.close()
})

test('a buggy balance:update handler does not break lifecycle completion', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })
  const spentNullifier = filledBytes(22)
  seedNotes(walletDB, wallet.walletId, [
    noteFixture(wallet.walletId, { commitment: filledBytes(21), nullifier: spentNullifier })
  ])
  seedChainNullifier(chainDB, spentNullifier, 1n)

  let completeFired = false
  let handlerError = ''
  client.on('balance:update', () => { throw new Error('handler boom') })
  client.on('error', (e) => { handlerError = e.error.message })
  client.on('sync:complete', () => { completeFired = true })

  await client.decrypt(wallet.walletId, encryptionKey, {
    chainId: SEPOLIA_CHAIN_ID,
    fromBlock: 1n,
    toBlock: 1n
  })

  assert.equal(handlerError, 'handler boom', 'handler error was re-emitted')
  assert.ok(completeFired, 'sync:complete still fires')
  client.close()
})

test('walletId filter scopes events to the matching wallet', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })

  const keyA = new Uint8Array(randomBytes(32))
  const keyB = new Uint8Array(randomBytes(32))
  const a = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: keyA })
  const b = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: keyB, index: 1 })

  let aHits = 0
  let bHits = 0
  client.on('sync:complete', () => { aHits += 1 }, { walletId: a.walletId })
  client.on('sync:complete', () => { bHits += 1 }, { walletId: b.walletId })

  await client.decrypt(a.walletId, keyA, {
    chainId: SEPOLIA_CHAIN_ID,
    fromBlock: 0n,
    toBlock: 0n
  })

  assert.equal(aHits, 1, 'wallet A filter received its own decrypt complete')
  assert.equal(bHits, 0, 'wallet B filter received nothing')
  client.close()
})

test('close() removes existing listeners', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })
  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })

  let hits = 0
  client.on('sync:start', () => { hits += 1 })
  client.close()

  await client.decrypt(wallet.walletId, encryptionKey, {
    chainId: SEPOLIA_CHAIN_ID,
    fromBlock: 0n,
    toBlock: 0n
  })

  assert.equal(hits, 0, 'listener registered before close was removed')
})

test('on() after close returns an inert unsubscribe', async () => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })
  const encryptionKey = new Uint8Array(randomBytes(32))
  const wallet = await client.createWallet({ mnemonic: MNEMONIC, encryptionKey })

  client.close()
  let hits = 0
  const unsubscribe = client.on('sync:start', () => { hits += 1 })

  await client.decrypt(wallet.walletId, encryptionKey, {
    chainId: SEPOLIA_CHAIN_ID,
    fromBlock: 0n,
    toBlock: 0n
  })

  assert.doesNotThrow(() => unsubscribe(), 'post-close unsubscribe is a no-op')
  assert.equal(hits, 0, 'post-close subscriber is inert')
})

test('two clients have independent buses', async () => {
  await initializeCryptographyLibs()
  const walletDBA = memWalletDB()
  const walletDBB = memWalletDB()
  const chainDBA = memChainDB()
  const chainDBB = memChainDB()
  const clientA = new RailgunClient({ walletDB: walletDBA, chainDB: chainDBA })
  const clientB = new RailgunClient({ walletDB: walletDBB, chainDB: chainDBB })

  let aHits = 0
  let bHits = 0
  clientA.on('sync:start', () => { aHits += 1 })
  clientB.on('sync:start', () => { bHits += 1 })

  const key = new Uint8Array(randomBytes(32))
  const wallet = await clientA.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  await clientA.decrypt(wallet.walletId, key, {
    chainId: SEPOLIA_CHAIN_ID,
    fromBlock: 0n,
    toBlock: 0n
  })

  assert.equal(aHits, 1, 'client A subscriber heard A events')
  assert.equal(bHits, 0, 'client B subscriber heard nothing from A')
  clientA.close()
  clientB.close()
})
