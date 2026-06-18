import type { NetworkName } from '../network-config.js'
import { NETWORK_CONFIG } from '../network-config.js'

import {
  PoiNodeAllUrlsFailedError,
  PoiNodeNetworkError,
  PoiNodeRpcError
} from './node-client-errors.js'
import type {
  FetchLike,
  FetchRequest,
  FetchResponse,
  GetPOIsPerListParams,
  GetPOIsPerListWireParams,
  JsonRpcErrorPayload,
  JsonRpcRequest,
  JsonRpcSuccess,
  POIsPerListResponse,
  PoiNodeClientOptions
} from './node-client-types.js'
import { POIJSONRPCMethod } from './node-client-types.js'
import type { TXIDVersion } from './types.js'

const POI_NODE_CLIENT_DEFAULT_TIMEOUT_MS = 15_000
const GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS = 1000
const EVM_CHAIN_TYPE = '0'

/**
 * JSON-RPC client for querying configured PPOI nodes.
 */
class PoiNodeClient {
  /** PPOI node URLs keyed by wallet-sdk network. */
  readonly #poiNodeUrls: PoiNodeClientOptions['poiNodeUrls']
  /** Per-request timeout in milliseconds. */
  readonly #timeoutMs: number
  /** Fetch implementation used for node requests. */
  readonly #fetch: FetchLike
  /** Monotonic JSON-RPC request id. */
  #nextRequestId = 1

  /**
   * Build a PPOI node client.
   * @param options - Node URL, timeout, and fetch configuration.
   */
  constructor (options: PoiNodeClientOptions) {
    this.#poiNodeUrls = clonePoiNodeUrls(options.poiNodeUrls)
    this.#timeoutMs = options.timeoutMs ?? POI_NODE_CLIENT_DEFAULT_TIMEOUT_MS
    this.#fetch = options.fetchFn ?? defaultFetch
  }

  /**
   * Query required POI-list statuses for blinded commitments.
   * @param params - Network, list keys, TXID version, and blinded commitments.
   * @returns POI statuses keyed by blinded commitment hex.
   */
  async getPOIsPerList (
    params: GetPOIsPerListParams
  ): Promise<POIsPerListResponse> {
    const batches = chunk(
      params.blindedCommitmentDatas,
      GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS
    )

    if (batches.length === 0) return {}

    const response: POIsPerListResponse = {}
    for (const batch of batches) {
      const batchResponse = await this.#request<
        GetPOIsPerListWireParams,
        POIsPerListResponse
      >(
        params.network,
        POIJSONRPCMethod.POIsPerList,
        {
          ...this.#chainParams(params),
          listKeys: params.listKeys,
          blindedCommitmentDatas: batch
        }
      )
      Object.assign(response, batchResponse)
    }
    return response
  }

  /**
   * Convert network parameters into PPOI node wire fields.
   * @param params - Network and TXID version.
   * @param params.network - Wallet-sdk network name.
   * @param params.txidVersion - TXID version to send to the node.
   * @returns Chain-scoped JSON-RPC params shared by PPOI methods.
   */
  #chainParams (
    params: { network: NetworkName, txidVersion: TXIDVersion }
  ) {
    return {
      chainType: EVM_CHAIN_TYPE,
      chainID: NETWORK_CONFIG[params.network].chainID.toString(),
      txidVersion: params.txidVersion
    }
  }

  /**
   * Attempt a JSON-RPC method against every usable configured URL.
   * @param network - Network whose PPOI node URLs should be used.
   * @param method - JSON-RPC method name.
   * @param params - Method params payload.
   * @returns Parsed method result.
   */
  async #request<Params, Result> (
    network: NetworkName,
    method: POIJSONRPCMethod,
    params: Params
  ): Promise<Result> {
    const urls = getUsableUrls(this.#poiNodeUrls[network])
    const errors: Error[] = []

    for (const url of urls) {
      try {
        return await this.#requestUrl<Params, Result>(
          url,
          network,
          method,
          params
        )
      } catch (error) {
        errors.push(toError(error))
      }
    }

    throw new PoiNodeAllUrlsFailedError({
      network,
      method,
      attemptedUrls: urls,
      errors
    })
  }

  /**
   * Send one JSON-RPC request to one PPOI node URL.
   * @param url - PPOI node endpoint URL.
   * @param network - Network used for error context.
   * @param method - JSON-RPC method name.
   * @param params - Method params payload.
   * @returns Parsed method result.
   */
  async #requestUrl<Params, Result> (
    url: string,
    network: NetworkName,
    method: POIJSONRPCMethod,
    params: Params
  ): Promise<Result> {
    const payload: JsonRpcRequest<Params> = {
      jsonrpc: '2.0',
      id: this.#nextRequestId++,
      method,
      params
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.#timeoutMs)

    try {
      const response = await this.#fetch(url, makeFetchRequest(payload, controller.signal))
      return await this.#readResponse<Result>(url, network, method, response)
    } catch (error) {
      if (
        error instanceof PoiNodeRpcError ||
        error instanceof PoiNodeNetworkError
      ) {
        throw error
      }
      throw new PoiNodeNetworkError({
        url,
        network,
        method,
        message: getErrorMessage(error),
        cause: error
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Validate and decode a PPOI node fetch response.
   * @param url - PPOI node endpoint URL.
   * @param network - Network used for error context.
   * @param method - JSON-RPC method name.
   * @param response - Fetch response from the node.
   * @returns Parsed JSON-RPC result.
   */
  async #readResponse<Result> (
    url: string,
    network: NetworkName,
    method: POIJSONRPCMethod,
    response: FetchResponse
  ): Promise<Result> {
    const { data, text } = await readResponseBody(response)

    if (isJsonRpcError(data)) {
      throw new PoiNodeRpcError({
        url,
        network,
        method,
        code: data.error.code,
        message: data.error.message,
        ...(data.error.data !== undefined && { data: data.error.data })
      })
    }

    if (!response.ok) {
      throw new PoiNodeNetworkError({
        url,
        network,
        method,
        message: `PPOI node HTTP ${response.status}: ${response.statusText}`,
        status: response.status,
        responseBody: text
      })
    }

    if (!isJsonRpcSuccess<Result>(data)) {
      throw new PoiNodeNetworkError({
        url,
        network,
        method,
        message: 'Malformed PPOI node JSON-RPC response',
        responseBody: text
      })
    }

    return data.result
  }
}

/**
 * Clone node URL arrays so caller-owned options cannot be mutated.
 * @param poiNodeUrls - URL map supplied to the client.
 * @returns A cloned URL map.
 */
function clonePoiNodeUrls (
  poiNodeUrls: PoiNodeClientOptions['poiNodeUrls']
): PoiNodeClientOptions['poiNodeUrls'] {
  const clone: PoiNodeClientOptions['poiNodeUrls'] = {}
  for (const network of Object.keys(poiNodeUrls) as Array<keyof typeof poiNodeUrls>) {
    const urls = poiNodeUrls[network]
    if (urls !== undefined) {
      clone[network] = [...urls]
    }
  }
  return clone
}

/**
 * Normalize URL input by trimming empty strings.
 * @param urls - Candidate URL list.
 * @returns Non-empty trimmed URLs.
 */
function getUsableUrls (urls: string[] | undefined): string[] {
  return urls?.map(url => url.trim()).filter(url => url.length > 0) ?? []
}

/**
 * Build the POST request for a JSON-RPC call.
 * @param payload - JSON-RPC request payload.
 * @param signal - Abort signal for request timeout handling.
 * @returns Fetch request object.
 */
function makeFetchRequest<Params> (
  payload: JsonRpcRequest<Params>,
  signal: AbortSignal
): FetchRequest {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  }
}

/**
 * Default fetch adapter used when tests do not inject one.
 * @param url - Target URL.
 * @param request - Fetch request options.
 * @returns Fetch response.
 */
const defaultFetch: FetchLike = async (url, request) => {
  return fetch(url, request) as Promise<FetchResponse>
}

/**
 * Check whether decoded data is a JSON-RPC error payload.
 * @param data - Decoded response body.
 * @returns True when the payload contains a JSON-RPC error object.
 */
function isJsonRpcError (data: unknown): data is JsonRpcErrorPayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof (data as JsonRpcErrorPayload).error?.code === 'number' &&
    typeof (data as JsonRpcErrorPayload).error?.message === 'string'
  )
}

/**
 * Check whether decoded data is a JSON-RPC success payload.
 * @param data - Decoded response body.
 * @returns True when the payload contains a result field.
 */
function isJsonRpcSuccess<Result> (data: unknown): data is JsonRpcSuccess<Result> {
  return (
    typeof data === 'object' &&
    data !== null &&
    'result' in data
  )
}

/**
 * Read a response body once and parse JSON from the captured text.
 * @param response - Fetch response to read.
 * @returns Decoded data plus the raw response text when available.
 */
async function readResponseBody (
  response: FetchResponse
): Promise<{ data: unknown, text: string | undefined }> {
  let text: string

  try {
    text = await response.text()
  } catch {
    return {
      data: undefined,
      text: undefined
    }
  }

  try {
    return {
      data: JSON.parse(text) as unknown,
      text
    }
  } catch {
    return {
      data: undefined,
      text
    }
  }
}

/**
 * Split an array into fixed-size chunks.
 * @param values - Values to split.
 * @param size - Maximum chunk size.
 * @returns Chunked values.
 */
function chunk<T> (values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

/**
 * Convert thrown values to Error instances.
 * @param error - Thrown value.
 * @returns Error instance.
 */
function toError (error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Extract a stable error message from a thrown value.
 * @param error - Thrown value.
 * @returns Human-readable error message.
 */
function getErrorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export {
  GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS,
  POI_NODE_CLIENT_DEFAULT_TIMEOUT_MS,
  PoiNodeClient
}
