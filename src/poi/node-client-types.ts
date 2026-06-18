import type { NetworkName } from '../network-config.js'

import type {
  BlindedCommitmentData,
  POIsPerList,
  TXIDVersion
} from './types.js'

enum POIJSONRPCMethod {
  POIsPerList = 'ppoi_pois_per_list'
}

type PoiNodeClientOptions = {
  poiNodeUrls: Partial<Record<NetworkName, string[]>>
  timeoutMs?: number
  fetchFn?: FetchLike
}

type FetchRequest = {
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}

type FetchResponse = {
  ok: boolean
  status: number
  statusText: string
  json: () => Promise<unknown>
  text: () => Promise<string>
}

type FetchLike = (
  url: string,
  request: FetchRequest
) => Promise<FetchResponse>

type JsonRpcRequest<Params> = {
  jsonrpc: '2.0'
  id: number
  method: POIJSONRPCMethod
  params: Params
}

type JsonRpcSuccess<Result> = {
  jsonrpc: '2.0'
  id: number | string | null
  result: Result
}

type JsonRpcErrorPayload = {
  jsonrpc: '2.0'
  id: number | string | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

type ChainParams = {
  chainType: string
  chainID: string
  txidVersion: TXIDVersion
}

type NetworkParams = {
  network: NetworkName
  txidVersion: TXIDVersion
}

type GetPOIsPerListParams = NetworkParams & {
  listKeys: string[]
  blindedCommitmentDatas: BlindedCommitmentData[]
}

type GetPOIsPerListWireParams = ChainParams & {
  listKeys: string[]
  blindedCommitmentDatas: BlindedCommitmentData[]
}

type POIsPerListResponse = {
  [blindedCommitment: string]: POIsPerList
}

export { POIJSONRPCMethod }
export type {
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
}
