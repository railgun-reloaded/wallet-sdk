import { randomBytes } from 'node:crypto'

import { bigIntToBytes } from '@railgun-reloaded/bytes'
import type { EVMBlock } from '@railgun-reloaded/scanner'
import { SourceAggregator } from '@railgun-reloaded/scanner'
import type { DBNewNote, WalletDB } from '@railgun-reloaded/storage'
import {
  createChainDB,
  createWallet,
  createWalletDB,
  getNoteByCommitment,
  insertNotesBatch
} from '@railgun-reloaded/storage'
import { initializeCryptographyLibs } from '@railgun-reloaded/wallet-node'
import { test } from 'brittle'

import {
  CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY,
  POIStatus,
  PoiNodeUrlsRequiredError,
  RailgunClient,
  SyncPhase
} from '../../src'
import { NetworkName } from '../../src/network-config'

import { MNEMONIC, VECTORS } from '../fixtures/wallet-vectors'

const CHAIN_ID = 11155111
const LIST_KEY = CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY

class FakeSource {
  isLiveProvider = false
  readonly #blocks: EVMBlock[]

  constructor (blocks: EVMBlock[]) {
    this.#blocks = blocks
  }

  async head () {
    return this.#blocks.length === 0
      ? 0n
      : this.#blocks[this.#blocks.length - 1]!.number
  }

  async * from (options: { startHeight: bigint, endHeight?: bigint | undefined }): AsyncGenerator<EVMBlock> {
    for (const block of this.#blocks) {
      if (block.number < options.startHeight) continue
      if (options.endHeight !== undefined && block.number > options.endHeight) break
      yield block
    }
  }

  destroy () {}
}

function memWalletDB (): WalletDB {
  return createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
}

function memChainDB () {
  return createChainDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/chain'
  })
}

function emptySepoliaSource (): SourceAggregator<EVMBlock> {
  return new SourceAggregator<EVMBlock>([
    new FakeSource([
      {
        number: 5784866n,
        hash: new Uint8Array(32),
        timestamp: 0n,
        transactions: []
      }
    ])
  ])
}

function noteFixture (walletId: string): DBNewNote {
  return {
    commitment: bigIntToBytes(1n, 32),
    walletId,
    chainId: CHAIN_ID,
    nullifier: bigIntToBytes(2n, 32),
    token: '0x0000000000000000000000000000000000000000',
    amount: 1n,
    spent: false,
    blockNumber: 9802000n,
    treeNumber: 0,
    treePosition: 3,
    commitmentType: 0,
    npk: bigIntToBytes(3n, 32)
  }
}

function installPoiFetchFixture (): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as {
      id: number
      params: {
        blindedCommitmentDatas: Array<{ blindedCommitment: string }>
      }
    }
    const result: Record<string, Record<string, POIStatus>> = {}
    for (const data of payload.params.blindedCommitmentDatas) {
      result[data.blindedCommitment] = {
        [LIST_KEY]: POIStatus.Valid
      }
    }
    const body = { jsonrpc: '2.0', id: payload.id, result }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as Response
  }) as typeof fetch

  return () => {
    globalThis.fetch = originalFetch
  }
}

test('RailgunClient.sync fires PoiRefresh on PPOI networks by default', async (t) => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({
    walletDB,
    chainDB,
    poiNodeUrls: { [NetworkName.EthereumSepolia]: ['https://poi.example'] }
  })
  const key = new Uint8Array(randomBytes(32))
  await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  const phases: SyncPhase[] = []

  const summary = await client.sync(VECTORS[0]!.walletId, key, {
    network: NetworkName.EthereumSepolia,
    dataSource: emptySepoliaSource(),
    endBlock: 5784866n,
    onProgress: progress => phases.push(progress.phase)
  })

  t.ok(phases.includes(SyncPhase.PoiRefresh))
  t.alike(summary.poi, {
    checked: 0,
    updated: 0,
    skipped: 0,
    failed: 0
  })
  client.close()
})

test('RailgunClient.sync skips PoiRefresh when refreshPoi is false', async (t) => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({
    walletDB,
    chainDB,
    poiNodeUrls: { [NetworkName.EthereumSepolia]: ['https://poi.example'] }
  })
  const key = new Uint8Array(randomBytes(32))
  await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })
  const phases: SyncPhase[] = []

  const summary = await client.sync(VECTORS[0]!.walletId, key, {
    network: NetworkName.EthereumSepolia,
    dataSource: emptySepoliaSource(),
    endBlock: 5784866n,
    refreshPoi: false,
    onProgress: progress => phases.push(progress.phase)
  })

  t.absent(phases.includes(SyncPhase.PoiRefresh))
  t.is(summary.poi, undefined)
  client.close()
})

test('RailgunClient.refreshPoiStatus works without a preceding sync', async (t) => {
  const restoreFetch = installPoiFetchFixture()
  const walletDB = memWalletDB()
  const walletId = 'manual-refresh-wallet'
  createWallet(walletDB, {
    id: walletId,
    encryptedKeys: new Uint8Array([7, 8, 9]),
    name: 'manual refresh wallet'
  })
  const note = noteFixture(walletId)
  insertNotesBatch(walletDB, [note])
  const client = new RailgunClient({
    walletDB,
    poiNodeUrls: { [NetworkName.EthereumSepolia]: ['https://poi.example'] }
  })

  try {
    const summary = await client.refreshPoiStatus(walletId, CHAIN_ID)

    t.alike(summary, {
      checked: 1,
      updated: 1,
      skipped: 0,
      failed: 0
    })
    t.alike(
      getNoteByCommitment(walletDB, note.commitment as Uint8Array)?.poisPerList,
      { [LIST_KEY]: POIStatus.Valid }
    )
  } finally {
    restoreFetch()
    client.close()
  }
})

test('RailgunClient requires PPOI node URLs for PPOI-aware sync', async (t) => {
  await initializeCryptographyLibs()
  const walletDB = memWalletDB()
  const chainDB = memChainDB()
  const client = new RailgunClient({ walletDB, chainDB })
  const key = new Uint8Array(randomBytes(32))
  await client.createWallet({ mnemonic: MNEMONIC, encryptionKey: key })

  try {
    await client.sync(VECTORS[0]!.walletId, key, {
      network: NetworkName.EthereumSepolia,
      dataSource: emptySepoliaSource(),
      endBlock: 5784866n
    })
    t.fail('expected missing PPOI node URL error')
  } catch (error) {
    t.ok(error instanceof PoiNodeUrlsRequiredError)
    if (error instanceof PoiNodeUrlsRequiredError) {
      t.is(error.network, NetworkName.EthereumSepolia)
    }
  } finally {
    client.close()
  }
})
