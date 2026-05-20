import { test } from 'brittle'

import { NetworkName } from '../../src/network-config'
import {
  BlindedCommitmentType,
  POIJSONRPCMethod,
  POIStatus,
  PoiNodeAllUrlsFailedError,
  PoiNodeClient,
  PoiNodeNetworkError,
  PoiNodeRpcError,
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

const LIST_KEY = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88'
const COMMON_PARAMS = {
  network: NetworkName.EthereumSepolia,
  txidVersion: TXIDVersion.V2_PoseidonMerkle,
  listKeys: [LIST_KEY]
}

type CapturedCall = {
  url: string
  request: FetchRequest
  payload: JsonRpcRequest<unknown>
}

function jsonResponse (
  result: unknown,
  status = 200,
  statusText = 'OK'
): FetchResponse {
  const body = result
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

function parsePayload (request: FetchRequest): JsonRpcRequest<unknown> {
  return JSON.parse(request.body) as JsonRpcRequest<unknown>
}

function oneCommitment () {
  return [{
    blindedCommitment: `0x${'01'.repeat(32)}`,
    type: BlindedCommitmentType.Transact
  }]
}

test('PoiNodeClient batches getPOIsPerList at 1000 commitments', async (t) => {
  const calls: CapturedCall[] = []
  const fetchFn: FetchLike = async (url, request) => {
    const payload = parsePayload(request)
    calls.push({ url, request, payload })
    const params = payload.params as GetPOIsPerListWireParams
    const result: POIsPerListResponse = {}
    for (const commitment of params.blindedCommitmentDatas) {
      result[commitment.blindedCommitment] = {
        [LIST_KEY]: POIStatus.Valid
      }
    }
    return jsonResponse({ jsonrpc: '2.0', id: payload.id, result })
  }

  const client = new PoiNodeClient({
    poiNodeUrls: { [NetworkName.EthereumSepolia]: ['https://poi.example'] },
    fetchFn
  })
  const blindedCommitmentDatas = Array.from({ length: 2500 }, (_, index) => ({
    blindedCommitment: `0x${index.toString(16).padStart(64, '0')}`,
    type: BlindedCommitmentType.Transact
  }))

  const result = await client.getPOIsPerList({
    ...COMMON_PARAMS,
    blindedCommitmentDatas
  })

  t.is(calls.length, 3)
  t.alike(
    calls.map(call => (call.payload.params as GetPOIsPerListWireParams)
      .blindedCommitmentDatas.length),
    [1000, 1000, 500]
  )
  t.alike(calls.map(call => call.payload.method), [
    POIJSONRPCMethod.POIsPerList,
    POIJSONRPCMethod.POIsPerList,
    POIJSONRPCMethod.POIsPerList
  ])
  t.is(Object.keys(result).length, 2500)
  t.is(result[blindedCommitmentDatas[0]!.blindedCommitment]?.[LIST_KEY], POIStatus.Valid)
})

test('PoiNodeClient failover is deterministic and first success wins', async (t) => {
  const calls: string[] = []
  const fetchFn: FetchLike = async (url, request) => {
    calls.push(url)
    const payload = parsePayload(request)
    if (url === 'https://bad.example') {
      throw new Error('offline')
    }
    return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: {} })
  }
  const client = new PoiNodeClient({
    poiNodeUrls: {
      [NetworkName.EthereumSepolia]: [
        'https://bad.example',
        'https://good.example'
      ]
    },
    fetchFn
  })

  await client.getPOIsPerList({
    ...COMMON_PARAMS,
    blindedCommitmentDatas: oneCommitment()
  })

  t.alike(calls, ['https://bad.example', 'https://good.example'])
})

test('PoiNodeClient all-URL failure includes attempted URLs', async (t) => {
  const fetchFn: FetchLike = async (url) => {
    throw new Error(`offline ${url}`)
  }
  const client = new PoiNodeClient({
    poiNodeUrls: {
      [NetworkName.EthereumSepolia]: [
        'https://bad-a.example',
        'https://bad-b.example'
      ]
    },
    fetchFn
  })

  try {
    await client.getPOIsPerList({
      ...COMMON_PARAMS,
      blindedCommitmentDatas: oneCommitment()
    })
    t.fail('expected all URLs to fail')
  } catch (error) {
    t.ok(error instanceof PoiNodeAllUrlsFailedError)
    if (error instanceof PoiNodeAllUrlsFailedError) {
      t.alike(error.attemptedUrls, [
        'https://bad-a.example',
        'https://bad-b.example'
      ])
      t.is(error.errors.length, 2)
    }
  }
})

test('PoiNodeClient maps JSON-RPC errors', async (t) => {
  const fetchFn: FetchLike = async (_url, request) => {
    const payload = parsePayload(request)
    return jsonResponse({
      jsonrpc: '2.0',
      id: payload.id,
      error: {
        code: -32602,
        message: 'Invalid params',
        data: { field: 'listKeys' }
      }
    }, 400, 'Bad Request')
  }
  const client = new PoiNodeClient({
    poiNodeUrls: { [NetworkName.EthereumSepolia]: ['https://poi.example'] },
    fetchFn
  })

  try {
    await client.getPOIsPerList({
      ...COMMON_PARAMS,
      blindedCommitmentDatas: oneCommitment()
    })
    t.fail('expected JSON-RPC error')
  } catch (error) {
    t.ok(error instanceof PoiNodeRpcError)
    if (error instanceof PoiNodeRpcError) {
      t.is(error.code, -32602)
      t.is(error.message, 'Invalid params')
      t.alike(error.data, { field: 'listKeys' })
    }
  }
})

test('PoiNodeClient maps HTTP errors to network errors', async (t) => {
  const fetchFn: FetchLike = async () => {
    return jsonResponse({ error: 'unavailable' }, 503, 'Service Unavailable')
  }
  const client = new PoiNodeClient({
    poiNodeUrls: { [NetworkName.EthereumSepolia]: ['https://poi.example'] },
    fetchFn
  })

  try {
    await client.getPOIsPerList({
      ...COMMON_PARAMS,
      blindedCommitmentDatas: oneCommitment()
    })
    t.fail('expected HTTP error')
  } catch (error) {
    t.ok(error instanceof PoiNodeNetworkError)
    if (error instanceof PoiNodeNetworkError) {
      t.is(error.status, 503)
      t.is(error.url, 'https://poi.example')
    }
  }
})

test('PoiNodeClient public API excludes deferred proof and TXID routes', (t) => {
  const client = new PoiNodeClient({ poiNodeUrls: {} })
  const publicClient = client as unknown as {
    getPOIsPerBlindedCommitment?: unknown
    getMerkleProofs?: unknown
    getValidatedTxid?: unknown
    validateTxidMerkleroot?: unknown
    validatePoiMerkleroots?: unknown
    submitTransactProof?: unknown
    submitLegacyTransactProofs?: unknown
    submitSingleCommitmentProofs?: unknown
  }

  t.is(publicClient.getPOIsPerBlindedCommitment, undefined)
  t.is(publicClient.getMerkleProofs, undefined)
  t.is(publicClient.getValidatedTxid, undefined)
  t.is(publicClient.validateTxidMerkleroot, undefined)
  t.is(publicClient.validatePoiMerkleroots, undefined)
  t.is(publicClient.submitTransactProof, undefined)
  t.is(publicClient.submitLegacyTransactProofs, undefined)
  t.is(publicClient.submitSingleCommitmentProofs, undefined)
})
