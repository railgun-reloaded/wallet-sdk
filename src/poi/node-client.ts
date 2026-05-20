import { NETWORK_CONFIG } from '../network-config'

import {
  PoiNodeAllUrlsFailedError,
  PoiNodeNetworkError,
  PoiNodeRpcError
} from './node-client-errors'
import {
  POIJSONRPCMethod
} from './node-client-types'
import type {
  FetchLike,
  FetchRequest,
  FetchResponse,
  GetMerkleProofsParams,
  GetMerkleProofsWireParams,
  GetPOIsPerBlindedCommitmentParams,
  GetPOIsPerBlindedCommitmentWireParams,
  GetPOIsPerListParams,
  GetPOIsPerListWireParams,
  GetValidatedTxidParams,
  GetValidatedTxidWireParams,
  JsonRpcErrorPayload,
  JsonRpcRequest,
  JsonRpcSuccess,
  MerkleProofsResponse,
  POIsPerBlindedCommitmentResponse,
  POIsPerListResponse,
  PoiNodeClientOptions,
  SubmitLegacyTransactProofsParams,
  SubmitLegacyTransactProofsWireParams,
  SubmitSingleCommitmentProofsParams,
  SubmitSingleCommitmentProofsWireParams,
  SubmitTransactProofParams,
  SubmitTransactProofWireParams,
  ValidatePoiMerklerootsParams,
  ValidatePoiMerklerootsWireParams,
  ValidateTxidMerklerootParams,
  ValidateTxidMerklerootWireParams,
  ValidatedTxidResponse
} from './node-client-types'

const POI_NODE_CLIENT_DEFAULT_TIMEOUT_MS = 15_000
const GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS = 1000
const GET_MERKLE_PROOFS_MAX_BLINDED_COMMITMENTS = 13
const EVM_CHAIN_TYPE = '0'

class PoiNodeClient {
  readonly #poiNodeUrls: PoiNodeClientOptions['poiNodeUrls']
  readonly #timeoutMs: number
  readonly #fetch: FetchLike
  #nextRequestId = 1

  constructor (options: PoiNodeClientOptions) {
    this.#poiNodeUrls = clonePoiNodeUrls(options.poiNodeUrls)
    this.#timeoutMs = options.timeoutMs ?? POI_NODE_CLIENT_DEFAULT_TIMEOUT_MS
    this.#fetch = options.fetchFn ?? defaultFetch
  }

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

  async getPOIsPerBlindedCommitment (
    params: GetPOIsPerBlindedCommitmentParams
  ): Promise<POIsPerBlindedCommitmentResponse> {
    assertMaxLength(
      params.blindedCommitmentDatas.length,
      GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS,
      'blindedCommitmentDatas'
    )
    if (params.blindedCommitmentDatas.length === 0) return {}

    return this.#request<
      GetPOIsPerBlindedCommitmentWireParams,
      POIsPerBlindedCommitmentResponse
    >(
      params.network,
      POIJSONRPCMethod.POIsPerBlindedCommitment,
      {
        ...this.#chainParams(params),
        listKey: params.listKey,
        blindedCommitmentDatas: params.blindedCommitmentDatas
      }
    )
  }

  async getMerkleProofs (
    params: GetMerkleProofsParams
  ): Promise<MerkleProofsResponse> {
    assertMaxLength(
      params.blindedCommitments.length,
      GET_MERKLE_PROOFS_MAX_BLINDED_COMMITMENTS,
      'blindedCommitments'
    )
    if (params.blindedCommitments.length === 0) return []

    return this.#request<GetMerkleProofsWireParams, MerkleProofsResponse>(
      params.network,
      POIJSONRPCMethod.MerkleProofs,
      {
        ...this.#chainParams(params),
        listKey: params.listKey,
        blindedCommitments: params.blindedCommitments
      }
    )
  }

  async getValidatedTxid (
    params: GetValidatedTxidParams
  ): Promise<ValidatedTxidResponse> {
    return this.#request<GetValidatedTxidWireParams, ValidatedTxidResponse>(
      params.network,
      POIJSONRPCMethod.ValidatedTXID,
      this.#chainParams(params)
    )
  }

  async validateTxidMerkleroot (
    params: ValidateTxidMerklerootParams
  ): Promise<boolean> {
    return this.#request<ValidateTxidMerklerootWireParams, boolean>(
      params.network,
      POIJSONRPCMethod.ValidateTXIDMerkleroot,
      {
        ...this.#chainParams(params),
        tree: params.tree,
        index: params.index,
        merkleroot: params.merkleroot
      }
    )
  }

  async validatePoiMerkleroots (
    params: ValidatePoiMerklerootsParams
  ): Promise<boolean> {
    return this.#request<ValidatePoiMerklerootsWireParams, boolean>(
      params.network,
      POIJSONRPCMethod.ValidatePOIMerkleroots,
      {
        ...this.#chainParams(params),
        listKey: params.listKey,
        poiMerkleroots: params.poiMerkleroots
      }
    )
  }

  async submitTransactProof (
    params: SubmitTransactProofParams
  ): Promise<void> {
    await this.#request<SubmitTransactProofWireParams, unknown>(
      params.network,
      POIJSONRPCMethod.SubmitTransactProof,
      {
        ...this.#chainParams(params),
        listKey: params.listKey,
        transactProofData: params.transactProofData
      }
    )
  }

  async submitLegacyTransactProofs (
    params: SubmitLegacyTransactProofsParams
  ): Promise<void> {
    await this.#request<SubmitLegacyTransactProofsWireParams, unknown>(
      params.network,
      POIJSONRPCMethod.SubmitLegacyTransactProofs,
      {
        ...this.#chainParams(params),
        listKeys: params.listKeys,
        legacyTransactProofDatas: params.legacyTransactProofDatas
      }
    )
  }

  async submitSingleCommitmentProofs (
    params: SubmitSingleCommitmentProofsParams
  ): Promise<void> {
    await this.#request<SubmitSingleCommitmentProofsWireParams, unknown>(
      params.network,
      POIJSONRPCMethod.SubmitSingleCommitmentProofs,
      {
        ...this.#chainParams(params),
        singleCommitmentProofsData: params.singleCommitmentProofsData
      }
    )
  }

  #chainParams (
    params: Pick<GetValidatedTxidParams, 'network' | 'txidVersion'>
  ) {
    return {
      chainType: EVM_CHAIN_TYPE,
      chainID: NETWORK_CONFIG[params.network].chainID.toString(),
      txidVersion: params.txidVersion
    }
  }

  async #request<Params, Result> (
    network: GetValidatedTxidParams['network'],
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

    if (errors.length === 1) {
      throw errors[0]
    }

    throw new PoiNodeAllUrlsFailedError({
      network,
      method,
      attemptedUrls: urls,
      errors
    })
  }

  async #requestUrl<Params, Result> (
    url: string,
    network: GetValidatedTxidParams['network'],
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

  async #readResponse<Result> (
    url: string,
    network: GetValidatedTxidParams['network'],
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

function getUsableUrls (urls: string[] | undefined): string[] {
  return urls?.map(url => url.trim()).filter(url => url.length > 0) ?? []
}

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

const defaultFetch: FetchLike = async (url, request) => {
  return fetch(url, request) as Promise<FetchResponse>
}

function isJsonRpcError (data: unknown): data is JsonRpcErrorPayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof (data as JsonRpcErrorPayload).error?.code === 'number' &&
    typeof (data as JsonRpcErrorPayload).error?.message === 'string'
  )
}

function isJsonRpcSuccess<Result> (data: unknown): data is JsonRpcSuccess<Result> {
  return (
    typeof data === 'object' &&
    data !== null &&
    'result' in data
  )
}

async function readResponseBody (
  response: FetchResponse
): Promise<{ data: unknown, text: string | undefined }> {
  try {
    const data = await response.json()
    return {
      data,
      text: JSON.stringify(data)
    }
  } catch {
    try {
      return {
        data: undefined,
        text: await response.text()
      }
    } catch {
      return {
        data: undefined,
        text: undefined
      }
    }
  }
}

function chunk<T> (values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function assertMaxLength (
  actual: number,
  max: number,
  field: string
): void {
  if (actual > max) {
    throw new RangeError(`${field} length ${actual} exceeds PPOI limit ${max}`)
  }
}

function toError (error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function getErrorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export {
  GET_MERKLE_PROOFS_MAX_BLINDED_COMMITMENTS,
  GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS,
  POI_NODE_CLIENT_DEFAULT_TIMEOUT_MS,
  PoiNodeClient
}
