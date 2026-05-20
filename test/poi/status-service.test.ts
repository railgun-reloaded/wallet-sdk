import { bigIntToBytes, bytesToBigInt, bytesToHex } from '@railgun-reloaded/bytes'
import type { DBNewNote, WalletDB } from '@railgun-reloaded/storage'
import {
  createWallet,
  createWalletDB,
  getNoteByCommitment,
  insertNotesBatch
} from '@railgun-reloaded/storage'
import { test } from 'brittle'

import { NetworkName } from '../../src/network-config'
import { SyncPhase } from '../../src/sync'
import {
  BlindedCommitmentType,
  CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY,
  POIStatus,
  PoiStatusService,
  getBlindedCommitmentForShield,
  getBlindedCommitmentForTransact
} from '../../src/poi'
import type {
  GetPOIsPerListParams,
  POIsPerListResponse,
  PoiStatusClient,
  RefreshSummary,
  SyncProgress
} from '../../src'

const WALLET_ID = 'wallet-id'
const CHAIN_ID = 11155111
const LIST_KEY = CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY

class MockPoiStatusClient implements PoiStatusClient {
  readonly calls: GetPOIsPerListParams[] = []
  readonly failOn = new Set<string>()

  async getPOIsPerList (
    params: GetPOIsPerListParams
  ): Promise<POIsPerListResponse> {
    this.calls.push({
      ...params,
      listKeys: [...params.listKeys],
      blindedCommitmentDatas: params.blindedCommitmentDatas.map(data => ({
        ...data
      }))
    })

    if (
      params.blindedCommitmentDatas
        .some(data => this.failOn.has(data.blindedCommitment))
    ) {
      throw new Error('fixture PPOI RPC error')
    }

    const response: POIsPerListResponse = {}
    for (const data of params.blindedCommitmentDatas) {
      response[data.blindedCommitment] = {
        [LIST_KEY]: POIStatus.Valid
      }
    }
    return response
  }
}

function memWalletDB (): WalletDB {
  return createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
}

function seedWallet (db: WalletDB, walletId = WALLET_ID): void {
  createWallet(db, {
    id: walletId,
    encryptedKeys: new Uint8Array([1, 2, 3]),
    name: 'PPOI fixture wallet'
  })
}

function noteFixture (
  index: number,
  overrides: Partial<DBNewNote> = {}
): DBNewNote {
  const value = BigInt(index + 1)
  return {
    commitment: bigIntToBytes(value, 32),
    walletId: WALLET_ID,
    chainId: CHAIN_ID,
    nullifier: bigIntToBytes(0x100000n + value, 32),
    token: '0x0000000000000000000000000000000000000000',
    amount: value,
    spent: false,
    blockNumber: 1000n + value,
    treeNumber: Math.floor(index / 65536),
    treePosition: index % 65536,
    commitmentType: 0,
    npk: bigIntToBytes(0x200000n + value, 32),
    ...overrides
  }
}

function serviceFor (
  db: WalletDB,
  poiNodeClient: PoiStatusClient
): PoiStatusService {
  return new PoiStatusService({
    walletDb: db,
    poiNodeClient,
    network: NetworkName.EthereumSepolia,
    listKeys: [LIST_KEY]
  })
}

function expectedBlindedCommitment (note: DBNewNote): Uint8Array {
  if (note.commitmentType === 0) {
    return getBlindedCommitmentForShield({
      commitment: note.commitment as Uint8Array,
      npk: bytesToBigInt(note.npk as Uint8Array),
      treePosition: BigInt(note.treePosition as number)
    })
  }

  return getBlindedCommitmentForTransact({
    commitment: note.commitment as Uint8Array,
    npk: bytesToBigInt(note.npk as Uint8Array),
    globalTreePosition: BigInt(note.treeNumber as number) * 65536n +
      BigInt(note.treePosition as number)
  })
}

function expectedBlindedCommitmentHex (note: DBNewNote): string {
  return bytesToHex(expectedBlindedCommitment(note), { prefix: true })
}

function assertSummary (
  t: { alike: (actual: unknown, expected: unknown, message?: string) => void },
  actual: RefreshSummary,
  expected: RefreshSummary
): void {
  t.alike(actual, expected)
}

test('PoiStatusService refreshes mixed Shield and Transact notes', async (t) => {
  const db = memWalletDB()
  seedWallet(db)
  const shield = noteFixture(1, {
    commitmentType: 0,
    treeNumber: 0,
    treePosition: 6
  })
  const transact = noteFixture(2, {
    commitmentType: 1,
    treeNumber: 1,
    treePosition: 5,
    outputType: 0
  })
  insertNotesBatch(db, [shield, transact])

  const poiNodeClient = new MockPoiStatusClient()
  const summary = await serviceFor(db, poiNodeClient).refresh(WALLET_ID, CHAIN_ID)

  assertSummary(t, summary, {
    checked: 2,
    updated: 2,
    skipped: 0,
    failed: 0
  })
  t.is(poiNodeClient.calls.length, 1)
  t.alike(
    poiNodeClient.calls[0]!.blindedCommitmentDatas.map(data => data.type),
    [BlindedCommitmentType.Shield, BlindedCommitmentType.Transact]
  )

  for (const note of [shield, transact]) {
    const stored = getNoteByCommitment(db, note.commitment as Uint8Array)
    t.alike(stored?.poisPerList, { [LIST_KEY]: POIStatus.Valid })
    t.is(
      bytesToHex(stored!.blindedCommitment!, { prefix: true }),
      expectedBlindedCommitmentHex(note)
    )
  }
})

test('PoiStatusService calls getPOIsPerList in 1000-note batches', async (t) => {
  const db = memWalletDB()
  seedWallet(db)
  const notes = Array.from({ length: 2500 }, (_, index) => noteFixture(index))
  insertNotesBatch(db, notes)

  const poiNodeClient = new MockPoiStatusClient()
  const summary = await serviceFor(db, poiNodeClient).refresh(WALLET_ID, CHAIN_ID)

  assertSummary(t, summary, {
    checked: 2500,
    updated: 2500,
    skipped: 0,
    failed: 0
  })
  t.is(poiNodeClient.calls.length, 3)
  t.alike(
    poiNodeClient.calls.map(call => call.blindedCommitmentDatas.length),
    [1000, 1000, 500]
  )
})

test('PoiStatusService keeps failed commitments pending while updating others', async (t) => {
  const db = memWalletDB()
  seedWallet(db)
  const goodShield = noteFixture(10, { commitmentType: 0 })
  const badTransact = noteFixture(11, {
    commitmentType: 1,
    treeNumber: 1,
    treePosition: 7
  })
  const goodTransact = noteFixture(12, {
    commitmentType: 1,
    treeNumber: 1,
    treePosition: 8
  })
  insertNotesBatch(db, [goodShield, badTransact, goodTransact])

  const poiNodeClient = new MockPoiStatusClient()
  poiNodeClient.failOn.add(expectedBlindedCommitmentHex(badTransact))
  const progress: SyncProgress[] = []

  const summary = await serviceFor(db, poiNodeClient).refresh(WALLET_ID, CHAIN_ID, {
    onProgress: progressEvent => progress.push(progressEvent)
  })

  assertSummary(t, summary, {
    checked: 3,
    updated: 2,
    skipped: 0,
    failed: 1
  })
  t.ok(progress.some(event =>
    event.phase === SyncPhase.PoiRefresh && event.error instanceof Error
  ))

  for (const note of [goodShield, goodTransact]) {
    const stored = getNoteByCommitment(db, note.commitment as Uint8Array)
    t.alike(stored?.poisPerList, { [LIST_KEY]: POIStatus.Valid })
  }

  const failed = getNoteByCommitment(db, badTransact.commitment as Uint8Array)
  t.is(failed?.poisPerList, null)
  t.is(
    bytesToHex(failed!.blindedCommitment!, { prefix: true }),
    expectedBlindedCommitmentHex(badTransact)
  )
})
