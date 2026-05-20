import { bytesToHex, hexToBytes } from '@railgun-reloaded/bytes'
import type { DBNewNote, WalletDB } from '@railgun-reloaded/storage'
import {
  createWallet,
  createWalletDB,
  getAllNotes,
  insertNotesBatch
} from '@railgun-reloaded/storage'
import { test } from 'brittle'

import { NetworkName } from '../../src/network-config'
import {
  BlindedCommitmentType,
  CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY,
  POIJSONRPCMethod,
  POIStatus,
  PoiNodeClient,
  PoiStatusService,
  TXIDVersion
} from '../../src/poi'
import type {
  FetchLike,
  FetchRequest,
  FetchResponse,
  GetPOIsPerListWireParams,
  JsonRpcRequest,
  POIsPerListResponse
} from '../../src/poi'

const WALLET_ID = 'fixture-wallet'
const CHAIN_ID = 11155111
const LIST_KEY = CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY
const SHIELD_BLINDED_COMMITMENT =
  '0x242b01e85c7bb5faaa2db9d9a36e1c4c111e1310e4fdd1b020346243b4725861'
const TRANSACT_BLINDED_COMMITMENT =
  '0x2949c953f84ebba68020a7f93bb0f23f628ba9ccd97cc97234aee057063b313b'

function memWalletDB (): WalletDB {
  return createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
}

function jsonResponse (request: FetchRequest, result: unknown): FetchResponse {
  const payload = JSON.parse(request.body) as JsonRpcRequest<unknown>
  const body = { jsonrpc: '2.0', id: payload.id, result }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

function fixtureNotes (): DBNewNote[] {
  return [
    {
      commitment: hexToBytes('13e2a79bbff0e43a0ca22a956f72e94441129d188ac129104fd894b4b61ce6db'),
      walletId: WALLET_ID,
      chainId: CHAIN_ID,
      nullifier: hexToBytes('0100000000000000000000000000000000000000000000000000000000000001'),
      token: '0x0000000000000000000000000000000000000000',
      amount: 100n,
      spent: false,
      blockNumber: 9802000n,
      treeNumber: 0,
      treePosition: 6,
      commitmentType: 0,
      npk: hexToBytes('10febc94c4a77ec233da9835ec7a0b5aefc1c9c73e811120579574bbe97af566')
    },
    {
      commitment: hexToBytes('ffeeddccbbaa99887766554433221100efcdab8967452301fedcba9876543210'),
      walletId: WALLET_ID,
      chainId: CHAIN_ID,
      nullifier: hexToBytes('0100000000000000000000000000000000000000000000000000000000000002'),
      token: '0x0000000000000000000000000000000000000000',
      amount: 200n,
      spent: false,
      blockNumber: 9802001n,
      treeNumber: 1,
      treePosition: 5,
      commitmentType: 1,
      outputType: 0,
      npk: hexToBytes('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100')
    }
  ]
}

test('PoiStatusService fixture locks getPOIsPerList payload and persisted statuses', async (t) => {
  const db = memWalletDB()
  createWallet(db, {
    id: WALLET_ID,
    encryptedKeys: new Uint8Array([4, 5, 6]),
    name: 'fixture wallet'
  })
  insertNotesBatch(db, fixtureNotes())

  const expectedResponse: POIsPerListResponse = {
    [SHIELD_BLINDED_COMMITMENT]: {
      [LIST_KEY]: POIStatus.Valid
    },
    [TRANSACT_BLINDED_COMMITMENT]: {
      [LIST_KEY]: POIStatus.Missing
    }
  }
  const payloads: Array<JsonRpcRequest<GetPOIsPerListWireParams>> = []
  const fetchFn: FetchLike = async (_url, request) => {
    const payload = JSON.parse(request.body) as JsonRpcRequest<GetPOIsPerListWireParams>
    payloads.push(payload)
    return jsonResponse(request, expectedResponse)
  }
  const poiNodeClient = new PoiNodeClient({
    poiNodeUrls: { [NetworkName.EthereumSepolia]: ['https://poi.example'] },
    fetchFn
  })
  const service = new PoiStatusService({
    walletDb: db,
    poiNodeClient,
    network: NetworkName.EthereumSepolia,
    listKeys: [LIST_KEY]
  })

  const summary = await service.refresh(WALLET_ID, CHAIN_ID)

  t.alike(summary, {
    checked: 2,
    updated: 2,
    skipped: 0,
    failed: 0
  })
  t.is(payloads.length, 1)
  t.is(payloads[0]!.method, POIJSONRPCMethod.POIsPerList)
  t.alike(
    {
      ...payloads[0]!.params,
      blindedCommitmentDatas: [...payloads[0]!.params.blindedCommitmentDatas]
        .sort((a, b) => a.blindedCommitment.localeCompare(b.blindedCommitment))
    },
    {
      chainType: '0',
      chainID: '11155111',
      txidVersion: TXIDVersion.V2_PoseidonMerkle,
      listKeys: [LIST_KEY],
      blindedCommitmentDatas: [
        {
          blindedCommitment: SHIELD_BLINDED_COMMITMENT,
          type: BlindedCommitmentType.Shield
        },
        {
          blindedCommitment: TRANSACT_BLINDED_COMMITMENT,
          type: BlindedCommitmentType.Transact
        }
      ].sort((a, b) => a.blindedCommitment.localeCompare(b.blindedCommitment))
    }
  )

  const rows = getAllNotes(db, WALLET_ID, CHAIN_ID)
  for (const row of rows) {
    const blindedCommitment = bytesToHex(row.blindedCommitment!, { prefix: true })
    t.alike(row.poisPerList, expectedResponse[blindedCommitment])
  }
})
