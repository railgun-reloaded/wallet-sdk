import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bytesToHex } from '@railgun-reloaded/bytes'
import type { DBNewNote } from '@railgun-reloaded/storage'
import type { WalletDB } from '@railgun-reloaded/storage/node'
import {
  createWallet,
  createWalletDB,
  getAllNotes,
  getNotesNeedingPoiRefresh,
  insertNotesBatch
} from '@railgun-reloaded/storage/node'

import { NetworkName } from '../../src/network-config.js'
import type {
  GetPOIsPerListParams,
  POIsPerListResponse,
  PoiStatusClient
} from '../../src/poi/index.js'
import {
  BlindedCommitmentType,
  CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY,
  POIJSONRPCMethod,
  POIStatus,
  PoiNodeNetworkError,
  PoiNodeRpcError,
  PoiStatusRefreshError,
  PoiStatusService
} from '../../src/poi/index.js'
import type { SyncProgress } from '../../src/sync/wallet-decryptor.js'

const WALLET_ID = 'status-wallet'
const CHAIN_ID = 11155111
const LIST_KEY = CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY

type RecordingClient = PoiStatusClient & {
  calls: GetPOIsPerListParams[]
}

/**
 * Build deterministic unique 32-byte fixture data.
 * @param value - Integer encoded into the final four bytes.
 * @param namespace - Prefix byte separating fixture fields.
 * @returns Stable 32-byte value.
 */
function fixtureBytes (value: number, namespace = 0): Uint8Array {
  const bytes = new Uint8Array(32)
  bytes[0] = namespace
  new DataView(bytes.buffer).setUint32(28, value)
  return bytes
}

/**
 * Create an in-memory wallet database with the fixture wallet.
 * @returns Fresh wallet database.
 */
async function memWalletDB (): Promise<WalletDB> {
  const db = await createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
  await createWallet(db, {
    id: WALLET_ID,
    encryptedKeys: fixtureBytes(1),
    name: 'status fixture wallet'
  })
  return db
}

/**
 * Build a received-note fixture with a precomputed blinded commitment.
 * @param index - Unique fixture index.
 * @param overrides - Note fields to override.
 * @returns Note suitable for storage insertion.
 */
function noteFixture (
  index: number,
  overrides: Partial<DBNewNote> = {}
): DBNewNote {
  return {
    commitment: fixtureBytes(index, 1),
    walletId: WALLET_ID,
    chainId: CHAIN_ID,
    nullifier: fixtureBytes(index, 2),
    token: '0x0000000000000000000000000000000000000000',
    amount: 1n,
    spent: false,
    blockNumber: BigInt(index),
    treeNumber: Math.floor(index / 65536),
    treePosition: index % 65536,
    commitmentType: 1,
    outputType: 0,
    blindedCommitment: fixtureBytes(index, 3),
    poisPerList: null,
    decryptedAt: new Date('2026-06-09T00:00:00.000Z'),
    ...overrides
  }
}

/**
 * Create a recording PPOI client backed by a deterministic handler.
 * @param handler - Response or failure behavior for each request.
 * @returns Structural PoiStatusClient plus captured calls.
 */
function recordingClient (
  handler: (
    params: GetPOIsPerListParams,
    callIndex: number
  ) => Promise<POIsPerListResponse> | POIsPerListResponse
): RecordingClient {
  const calls: GetPOIsPerListParams[] = []
  return {
    calls,
    /**
     * Record and handle one PPOI status request.
     * @param params - PPOI request parameters.
     * @returns Handler response.
     */
    async getPOIsPerList (params: GetPOIsPerListParams) {
      calls.push(params)
      return handler(params, calls.length - 1)
    }
  }
}

/**
 * Build a Valid response for every commitment in a request.
 * @param params - Captured PPOI request.
 * @returns Status map keyed by blinded commitment.
 */
function validResponse (
  params: GetPOIsPerListParams
): POIsPerListResponse {
  return Object.fromEntries(params.blindedCommitmentDatas.map(data => [
    data.blindedCommitment,
    { [LIST_KEY]: POIStatus.Valid }
  ]))
}

/**
 * Insert large fixture sets below SQLite's bound-variable limit.
 * @param db - Wallet database to seed.
 * @param notes - Notes to insert.
 */
async function seedNotes (db: WalletDB, notes: DBNewNote[]): Promise<void> {
  const batchSize = 500
  for (let index = 0; index < notes.length; index += batchSize) {
    await insertNotesBatch(db, notes.slice(index, index + batchSize))
  }
}

test('PoiStatusService returns an exact empty summary without an RPC call', async () => {
  const db = await memWalletDB()
  const client = recordingClient(validResponse)
  const service = new PoiStatusService({
    walletDb: db,
    poiNodeClient: client,
    network: NetworkName.EthereumSepolia
  })

  assert.deepStrictEqual(await service.refresh(WALLET_ID, CHAIN_ID), {
    checked: 0,
    updated: 0,
    skipped: 0,
    failed: 0
  })
  assert.equal(client.calls.length, 0)
})

test('PoiStatusService batches 1, 1000, 1001, and 2500 candidates exactly', async (t) => {
  for (const candidateCount of [1, 1000, 1001, 2500]) {
    await t.test(`${candidateCount} candidates`, async () => {
      const db = await memWalletDB()
      await seedNotes(db, Array.from(
        { length: candidateCount },
        (_, index) => noteFixture(index + 1)
      ))
      const client = recordingClient(validResponse)
      const service = new PoiStatusService({
        walletDb: db,
        poiNodeClient: client,
        network: NetworkName.EthereumSepolia
      })

      const summary = await service.refresh(WALLET_ID, CHAIN_ID)

      assert.deepStrictEqual(summary, {
        checked: candidateCount,
        updated: candidateCount,
        skipped: 0,
        failed: 0
      })
      assert.equal(client.calls.length, Math.ceil(candidateCount / 1000))
      assert.deepStrictEqual(
        client.calls.map(call => call.blindedCommitmentDatas.length),
        candidateCount === 1001
          ? [1000, 1]
          : candidateCount === 2500
            ? [1000, 1000, 500]
            : [candidateCount]
      )
    })
  }
})

test('PoiStatusService refreshes only the targeted SQL candidate rows', async () => {
  const db = await memWalletDB()
  await insertNotesBatch(db, [
    noteFixture(1),
    noteFixture(2, { poisPerList: { [LIST_KEY]: POIStatus.Missing } }),
    noteFixture(3, { poisPerList: { [LIST_KEY]: POIStatus.Valid } })
  ])
  const allNotes = await getAllNotes(db, WALLET_ID, CHAIN_ID)
  const sqlCandidates = await getNotesNeedingPoiRefresh(db, WALLET_ID, CHAIN_ID)
  const client = recordingClient(validResponse)
  const service = new PoiStatusService({
    walletDb: db,
    poiNodeClient: client,
    network: NetworkName.EthereumSepolia
  })

  const summary = await service.refresh(WALLET_ID, CHAIN_ID)

  assert.equal(allNotes.length, 3)
  assert.equal(sqlCandidates.length, 1)
  assert.deepStrictEqual(summary, {
    checked: 1,
    updated: 1,
    skipped: 0,
    failed: 0
  })
  assert.equal(client.calls.length, 1)
  assert.deepStrictEqual(client.calls[0]!.blindedCommitmentDatas, [{
    blindedCommitment: `0x${bytesToHex(fixtureBytes(1, 3))}`,
    type: BlindedCommitmentType.Transact
  }])
})

test('derivation failures are typed, counted, and leave pending status', async () => {
  const db = await memWalletDB()
  await insertNotesBatch(db, [
    noteFixture(1),
    noteFixture(2, {
      blindedCommitment: null,
      npk: null
    })
  ])
  const client = recordingClient(validResponse)
  const progress: SyncProgress[] = []
  const service = new PoiStatusService({
    walletDb: db,
    poiNodeClient: client,
    network: NetworkName.EthereumSepolia
  })

  const summary = await service.refresh(WALLET_ID, CHAIN_ID, {
    /**
     * Capture progress for typed error assertions.
     * @param event - Refresh progress event.
     */
    onProgress: (event) => {
      progress.push(event)
    }
  })

  assert.deepStrictEqual(summary, {
    checked: 2,
    updated: 1,
    skipped: 0,
    failed: 1
  })
  const error = progress.find(event => event.error !== undefined)?.error
  assert.ok(error instanceof PoiStatusRefreshError)
  assert.equal(error.code, 'BlindedCommitmentDerivationFailed')
  const failedNote = (await getAllNotes(db, WALLET_ID, CHAIN_ID))
    .find(note => bytesToHex(note.commitment) === bytesToHex(fixtureBytes(2, 1)))
  assert.equal(failedNote?.poisPerList, null)
  assert.equal(failedNote?.blindedCommitment, null)
})

test('one failed network batch leaves a later successful batch persisted', async () => {
  const db = await memWalletDB()
  await insertNotesBatch(db, Array.from({ length: 1001 }, (_, index) => noteFixture(
    index + 1
  )))
  const client = recordingClient((params, callIndex) => {
    if (callIndex === 0) {
      throw new PoiNodeNetworkError({
        url: 'https://ppoi.example.test',
        network: NetworkName.EthereumSepolia,
        method: POIJSONRPCMethod.POIsPerList,
        message: 'fixture network failure'
      })
    }
    return validResponse(params)
  })
  const service = new PoiStatusService({
    walletDb: db,
    poiNodeClient: client,
    network: NetworkName.EthereumSepolia
  })

  const summary = await service.refresh(WALLET_ID, CHAIN_ID)

  assert.deepStrictEqual(summary, {
    checked: 1001,
    updated: 1,
    skipped: 0,
    failed: 1000
  })
  assert.equal(client.calls.length, 2)
  const notes = await getAllNotes(db, WALLET_ID, CHAIN_ID)
  assert.equal(notes[0]!.poisPerList, null)
  assert.deepStrictEqual(notes.at(-1)!.poisPerList, {
    [LIST_KEY]: POIStatus.Valid
  })
})

test('node failure does not pre-persist a newly derived blinded commitment', async () => {
  const db = await memWalletDB()
  await insertNotesBatch(db, [noteFixture(1, {
    blindedCommitment: null,
    npk: fixtureBytes(50, 4)
  })])
  const client = recordingClient(() => {
    throw new PoiNodeNetworkError({
      url: 'https://ppoi.example.test',
      network: NetworkName.EthereumSepolia,
      method: POIJSONRPCMethod.POIsPerList,
      message: 'fixture network failure'
    })
  })
  const service = new PoiStatusService({
    walletDb: db,
    poiNodeClient: client,
    network: NetworkName.EthereumSepolia
  })

  const summary = await service.refresh(WALLET_ID, CHAIN_ID)

  assert.deepStrictEqual(summary, {
    checked: 1,
    updated: 0,
    skipped: 0,
    failed: 1
  })
  const note = (await getAllNotes(db, WALLET_ID, CHAIN_ID))[0]!
  assert.equal(note.blindedCommitment, null)
  assert.equal(note.poisPerList, null)
})

test('one bad commitment is isolated while unrelated rows succeed', async () => {
  const db = await memWalletDB()
  await insertNotesBatch(db, [noteFixture(1), noteFixture(2), noteFixture(3)])
  const badCommitment = `0x${bytesToHex(fixtureBytes(2, 3))}`
  const client = recordingClient((params) => {
    if (params.blindedCommitmentDatas.some(
      data => data.blindedCommitment === badCommitment
    )) {
      throw new PoiNodeRpcError({
        url: 'https://ppoi.example.test',
        network: NetworkName.EthereumSepolia,
        method: POIJSONRPCMethod.POIsPerList,
        code: -32000,
        message: 'fixture commitment rejected'
      })
    }
    return validResponse(params)
  })
  const service = new PoiStatusService({
    walletDb: db,
    poiNodeClient: client,
    network: NetworkName.EthereumSepolia
  })

  const summary = await service.refresh(WALLET_ID, CHAIN_ID)

  assert.deepStrictEqual(summary, {
    checked: 3,
    updated: 2,
    skipped: 0,
    failed: 1
  })
  const notes = await getAllNotes(db, WALLET_ID, CHAIN_ID)
  assert.equal(notes.filter(note => note.poisPerList !== null).length, 2)
  assert.equal(
    notes.find(note => bytesToHex(note.commitment) === bytesToHex(fixtureBytes(2, 1)))
      ?.poisPerList,
    null
  )
})

test('omitted node results are typed failures and leave pending status', async () => {
  const db = await memWalletDB()
  await insertNotesBatch(db, [
    noteFixture(1),
    noteFixture(2)
  ])
  const client = recordingClient(params => ({
    [params.blindedCommitmentDatas[0]!.blindedCommitment]: {
      [LIST_KEY]: POIStatus.Valid
    }
  }))
  const progress: SyncProgress[] = []
  const service = new PoiStatusService({
    walletDb: db,
    poiNodeClient: client,
    network: NetworkName.EthereumSepolia
  })

  const summary = await service.refresh(WALLET_ID, CHAIN_ID, {
    /**
     * Capture progress for typed error assertions.
     * @param event - Refresh progress event.
     */
    onProgress: (event) => {
      progress.push(event)
    }
  })

  assert.deepStrictEqual(summary, {
    checked: 2,
    updated: 1,
    skipped: 0,
    failed: 1
  })
  const error = progress.find(event => (
    event.error instanceof PoiStatusRefreshError &&
    event.error.code === 'MissingStatusResponse'
  ))?.error
  assert.ok(error instanceof PoiStatusRefreshError)
  const notes = await getAllNotes(db, WALLET_ID, CHAIN_ID)
  assert.equal(notes[1]!.poisPerList, null)
  assert.equal(summary.checked, summary.updated + summary.skipped + summary.failed)
})

test('empty required-list configuration counts candidates as skipped', async () => {
  const db = await memWalletDB()
  await insertNotesBatch(db, [noteFixture(1), noteFixture(2)])
  const client = recordingClient(validResponse)
  const service = new PoiStatusService({
    walletDb: db,
    poiNodeClient: client,
    network: NetworkName.EthereumSepolia,
    listKeys: []
  })

  assert.deepStrictEqual(await service.refresh(WALLET_ID, CHAIN_ID), {
    checked: 2,
    updated: 0,
    skipped: 2,
    failed: 0
  })
  assert.equal(client.calls.length, 0)
})

test('status requests preserve commitment type metadata', async () => {
  const db = await memWalletDB()
  await insertNotesBatch(db, [
    noteFixture(1, {
      commitmentType: 0,
      blindedCommitment: null,
      npk: fixtureBytes(60, 4)
    }),
    noteFixture(2, {
      commitmentType: 1,
      blindedCommitment: null,
      npk: fixtureBytes(61, 4)
    })
  ])
  const client = recordingClient(validResponse)
  const service = new PoiStatusService({
    walletDb: db,
    poiNodeClient: client,
    network: NetworkName.EthereumSepolia
  })

  await service.refresh(WALLET_ID, CHAIN_ID)

  assert.deepStrictEqual(
    client.calls[0]!.blindedCommitmentDatas.map(data => data.type),
    [BlindedCommitmentType.Shield, BlindedCommitmentType.Transact]
  )
  assert.equal(
    (await getAllNotes(db, WALLET_ID, CHAIN_ID))
      .every(note => note.blindedCommitment !== null),
    true
  )
})
