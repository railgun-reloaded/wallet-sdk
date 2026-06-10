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
  PoiNodeAllUrlsFailedError,
  PoiNodeClient,
  PoiNodeNetworkError,
  PoiNodeRpcError,
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
 * @param urls - Ordered PPOI node URLs.
 * @param timeoutMs - Optional request timeout.
 * @returns Configured PPOI node client.
 */
function makeClient (
  fetchFn: FetchLike,
  urls: string[] = [NODE_URL],
  timeoutMs?: number
): PoiNodeClient {
  return new PoiNodeClient({
    poiNodeUrls: { [NetworkName.EthereumSepolia]: urls },
    fetchFn,
    ...(timeoutMs !== undefined && { timeoutMs })
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
    assert.ok(error instanceof PoiNodeAllUrlsFailedError)
    assert.ok(error.lastError instanceof PoiNodeNetworkError)
    return error.lastError
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

test('PoiNodeClient batches 0, 1, 1000, 1001, and 2500 inputs', async () => {
  const cases = [
    { count: 0, batches: [] },
    { count: 1, batches: [1] },
    { count: 1000, batches: [1000] },
    { count: 1001, batches: [1000, 1] },
    { count: 2500, batches: [1000, 1000, 500] }
  ]

  for (const testCase of cases) {
    const batchSizes: number[] = []
    const inputs = Array.from({ length: testCase.count }, (_, index) => ({
      blindedCommitment: `commitment-${index}`,
      type: BlindedCommitmentType.Transact
    }))
    const client = makeClient(async (_url, request) => {
      const payload = JSON.parse(
        request.body
      ) as JsonRpcRequest<{ blindedCommitmentDatas: typeof inputs }>
      batchSizes.push(payload.params.blindedCommitmentDatas.length)
      return makeResponse(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: Object.fromEntries(
          payload.params.blindedCommitmentDatas.map(({ blindedCommitment }) => [
            blindedCommitment,
            { [LIST_KEY]: POIStatus.Valid }
          ])
        )
      }))
    })

    const result = await client.getPOIsPerList({
      network: NetworkName.EthereumSepolia,
      txidVersion: TXIDVersion.V2_PoseidonMerkle,
      listKeys: [LIST_KEY],
      blindedCommitmentDatas: inputs
    })

    assert.deepStrictEqual(batchSizes, testCase.batches)
    assert.deepStrictEqual(Object.keys(result), inputs.map(
      ({ blindedCommitment }) => blindedCommitment
    ))
  }
})

test('PoiNodeClient failover is in-order and stops at first success', async () => {
  const urls = ['https://first.test', 'https://second.test', 'https://third.test']
  const attempted: string[] = []
  const client = makeClient(async (url) => {
    attempted.push(url)
    if (url === urls[0]) throw new Error('first failed')
    return makeResponse(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        [BLINDED_COMMITMENT]: { [LIST_KEY]: POIStatus.Valid }
      }
    }))
  }, urls)

  await getPOIsPerList(client)

  assert.deepStrictEqual(attempted, urls.slice(0, 2))
})

test('PoiNodeClient aggregates every attempted URL and preserves final cause', async () => {
  const urls = ['https://first.test', 'https://second.test']
  const client = makeClient(async (url) => {
    if (url === urls[0]) throw new Error('network failed')
    return makeResponse(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32001, message: 'final rpc failure', data: { retry: false } }
    }))
  }, urls)

  await assert.rejects(getPOIsPerList(client), (error: unknown) => {
    assert.ok(error instanceof PoiNodeAllUrlsFailedError)
    assert.deepStrictEqual(error.attemptedUrls, urls)
    assert.equal(error.errors.length, 2)
    assert.ok(error.lastError instanceof PoiNodeRpcError)
    assert.strictEqual(error.cause, error.lastError)
    assert.equal(error.lastError.code, -32001)
    assert.equal(error.lastError.message, 'final rpc failure')
    assert.deepStrictEqual(error.lastError.data, { retry: false })
    return true
  })
})

test('PoiNodeClient uses the aggregate contract for one or zero URLs', async () => {
  const oneUrlClient = makeClient(async () => {
    throw new Error('offline')
  })
  const noUrlClient = makeClient(async () => {
    assert.fail('fetch must not be called')
  }, [])

  for (const [client, attemptedUrls] of [
    [oneUrlClient, [NODE_URL]],
    [noUrlClient, []]
  ] as const) {
    await assert.rejects(getPOIsPerList(client), (error: unknown) => {
      assert.ok(error instanceof PoiNodeAllUrlsFailedError)
      assert.deepStrictEqual(error.attemptedUrls, attemptedUrls)
      return true
    })
  }
})

test('PoiNodeClient maps thrown, abort, and timeout failures to network causes', async () => {
  const thrown = await assertNetworkError(() => getPOIsPerList(
    makeClient(async () => {
      throw new TypeError('network unavailable')
    })
  ))
  assert.match(thrown.message, /network unavailable/)

  const aborted = await assertNetworkError(() => getPOIsPerList(
    makeClient(async () => {
      throw new DOMException('request aborted', 'AbortError')
    })
  ))
  assert.match(aborted.message, /request aborted/)

  const timedOut = await assertNetworkError(() => getPOIsPerList(
    makeClient(async (_url, request) => {
      return await new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new DOMException('timed out', 'AbortError'))
        })
      })
    }, [NODE_URL], 5)
  ))
  assert.match(timedOut.message, /timed out/)
})

test('PoiNodeClient exposes no deferred M1 methods', () => {
  const client = makeClient(async () => {
    assert.fail('fetch must not be called')
  })
  const deferredMethods = [
    'getPOIsPerBlindedCommitment',
    'getMerkleProofs',
    'getValidatedTXID',
    'validateTXIDMerkleroot',
    'validatePOIMerkleroots',
    'submitTransactProof',
    'submitLegacyTransactProofs',
    'submitSingleCommitmentProofs'
  ]

  for (const method of deferredMethods) {
    assert.equal(method in client, false)
  }
  assert.deepStrictEqual(Object.values(POIJSONRPCMethod), [
    'ppoi_pois_per_list'
  ])
})
