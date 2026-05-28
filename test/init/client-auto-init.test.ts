import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import type { EVMBlock } from '@railgun-reloaded/scanner'
import { SourceAggregator } from '@railgun-reloaded/scanner'
import type { ChainDB, WalletDB } from '@railgun-reloaded/storage'
import { createChainDB, createWalletDB } from '@railgun-reloaded/storage'

import { RailgunClient } from '../../src/client'
import { NetworkName } from '../../src/network-config'
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

/**
 * Build a fresh in-memory ChainDB for RailgunClient injection.
 * @returns Drizzle-wrapped in-memory SQLite.
 */
function memChainDB (): ChainDB {
  return createChainDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/chain'
  })
}

/**
 * Minimal `DataSource` fake that drains a fixed block list once. Used to
 * exercise the scan→decrypt pipeline without touching a live indexer.
 */
class FakeSource {
  /** Non-live so the aggregator treats the source as drain-to-tip. */
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
   * Highest block number this source can serve, or 0n when empty.
   * @returns Current head as a bigint.
   */
  async head (): Promise<bigint> {
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
  destroy (): void {}
}

test('createWallet works without any prior crypto init (no init needed)', async () => {
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

test('sync auto-initializes cryptography end-to-end without a manual init call', async () => {
  const walletDB = memDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })
  try {
    const key = new Uint8Array(randomBytes(32))
    await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })

    const blocks: EVMBlock[] = [
      { number: 5784866n, hash: new Uint8Array(32), timestamp: 0n, transactions: [] }
    ]
    const aggregator = new SourceAggregator<EVMBlock>([new FakeSource(blocks)])

    const summary = await client.sync(VECTORS[0]!.walletId, key, {
      network: NetworkName.EthereumSepolia,
      dataSource: aggregator,
      endBlock: 5784866n,
      refreshPoi: false
    })

    assert.equal(summary.decrypt.chainId, 11155111)
    assert.equal(summary.decrypt.notesAdded, 0)
    assert.equal(summary.decrypt.notesSpent, 0)
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
