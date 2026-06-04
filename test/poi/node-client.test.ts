import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NetworkName } from '../../src/network-config'
import type {
  FetchLike,
  FetchRequest,
  FetchResponse,
  JsonRpcRequest
} from '../../src/poi'
import {
  BlindedCommitmentType,
  POIJSONRPCMethod,
  POIStatus,
  PoiNodeClient,
  PoiNodeNetworkError,
  TXIDVersion
} from '../../src/poi'

const NODE_URL = 'https://ppoi.example.test'
const LIST_KEY = 'list-key'
const BLINDED_COMMITMENT = '0x1234'
const BLINDED_COMMITMENT_DATA = {
  blindedCommitment: BLINDED_COMMITMENT,
  type: BlindedCommitmentType.Transact
}

type ResponseOptions = {
  ok?: boolean
  status?: number
  statusText?: string
}

type CapturedRequest = {
  url: string
  request: FetchRequest
  payload: JsonRpcRequest<unknown>
}

/**
 * Build a fetch response that enforces one-shot body consumption.
 * @param body - Raw response body.
 * @param options - Optional HTTP response metadata.
 * @returns Fetch response test double.
 */
function makeResponse (
  body: string,
  options: ResponseOptions = {}
): FetchResponse {
  let consumed = false

  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    /**
     * Consume the body as JSON.
     * @returns Parsed response body.
     */
    async json () {
      if (consumed) {
        throw new TypeError('Body has already been used')
      }
      consumed = true
      return JSON.parse(body) as unknown
    },
    /**
     * Consume the body as raw text.
     * @returns Raw response body.
     */
    async text () {
      if (consumed) {
        throw new TypeError('Body has already been used')
      }
      consumed = true
      return body
    }
  }
}

/**
 * Build a client with one Sepolia PPOI node URL.
 * @param fetchFn - Fetch test double.
 * @returns Configured PPOI node client.
 */
function makeClient (
  fetchFn: FetchLike
): PoiNodeClient {
  return new PoiNodeClient({
    poiNodeUrls: { [NetworkName.EthereumSepolia]: [NODE_URL] },
    fetchFn
  })
}

/**
 * Query the shared POIs-per-list fixture.
 * @param client - PPOI node client under test.
 * @returns POIs-per-list response.
 */
function getPOIsPerList (
  client: PoiNodeClient
): Promise<Record<string, Record<string, POIStatus>>> {
  return client.getPOIsPerList({
    network: NetworkName.EthereumSepolia,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    listKeys: [LIST_KEY],
    blindedCommitmentDatas: [BLINDED_COMMITMENT_DATA]
  })
}

/**
 * Assert that a promise rejects with a PPOI network error.
 * @param run - Function expected to reject.
 * @returns Captured PPOI network error.
 */
async function assertNetworkError (
  run: () => Promise<unknown>
): Promise<PoiNodeNetworkError> {
  try {
    await run()
    assert.fail('expected PPOI node network error')
  } catch (error) {
    assert.ok(error instanceof PoiNodeNetworkError)
    return error
  }
}

test('PoiNodeClient sends expected JSON-RPC request and parses result', async () => {
  const capturedRequests: CapturedRequest[] = []
  /**
   * Capture one outgoing fetch request and return a successful response.
   * @param url - Requested URL.
   * @param request - Fetch request payload.
   * @returns Successful PPOI node response.
   */
  const fetchFn: FetchLike = async (url, request) => {
    capturedRequests.push({
      url,
      request,
      payload: JSON.parse(request.body) as JsonRpcRequest<unknown>
    })
    return makeResponse(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        [BLINDED_COMMITMENT]: {
          [LIST_KEY]: POIStatus.Valid
        }
      }
    }))
  }

  const result = await getPOIsPerList(makeClient(fetchFn))

  assert.deepEqual(result, {
    [BLINDED_COMMITMENT]: {
      [LIST_KEY]: POIStatus.Valid
    }
  })
  assert.equal(capturedRequests.length, 1)
  assert.equal(capturedRequests[0]!.url, NODE_URL)
  assert.equal(capturedRequests[0]!.request.method, 'POST')
  assert.equal(capturedRequests[0]!.request.headers['content-type'], 'application/json')
  assert.deepEqual(capturedRequests[0]!.payload, {
    jsonrpc: '2.0',
    id: 1,
    method: POIJSONRPCMethod.POIsPerList,
    params: {
      chainType: '0',
      chainID: '11155111',
      txidVersion: TXIDVersion.V2_PoseidonMerkle,
      listKeys: [LIST_KEY],
      blindedCommitmentDatas: [BLINDED_COMMITMENT_DATA]
    }
  })
})

test('PoiNodeClient preserves plain-text HTTP error bodies', async () => {
  const client = makeClient(async () => makeResponse('upstream unavailable', {
    ok: false,
    status: 503,
    statusText: 'Service Unavailable'
  }))

  const error = await assertNetworkError(() => getPOIsPerList(client))

  assert.equal(error.status, 503)
  assert.equal(error.responseBody, 'upstream unavailable')
  assert.equal(
    error.message,
    'PPOI node HTTP 503: Service Unavailable'
  )
})

test('PoiNodeClient preserves malformed JSON response bodies', async () => {
  const client = makeClient(async () => makeResponse('{"jsonrpc":"2.0"'))

  const error = await assertNetworkError(() => getPOIsPerList(client))

  assert.equal(error.responseBody, '{"jsonrpc":"2.0"')
  assert.equal(error.message, 'Malformed PPOI node JSON-RPC response')
})
