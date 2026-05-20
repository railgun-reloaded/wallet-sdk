import type { NetworkName } from '../network-config'

import type {
  BlindedCommitmentData,
  POIsPerList
} from './types'
import { TXIDVersion } from './types'

enum POIJSONRPCMethod {
  POIsPerList = 'ppoi_pois_per_list',
  POIsPerBlindedCommitment = 'ppoi_pois_per_blinded_commitment',
  MerkleProofs = 'ppoi_merkle_proofs',
  ValidatedTXID = 'ppoi_validated_txid',
  ValidateTXIDMerkleroot = 'ppoi_validate_txid_merkleroot',
  ValidatePOIMerkleroots = 'ppoi_validate_poi_merkleroots',
  SubmitTransactProof = 'ppoi_submit_transact_proof',
  SubmitLegacyTransactProofs = 'ppoi_submit_legacy_transact_proofs',
  SubmitSingleCommitmentProofs = 'ppoi_submit_single_commitment_proofs'
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

type GetPOIsPerBlindedCommitmentParams = NetworkParams & {
  listKey: string
  blindedCommitmentDatas: BlindedCommitmentData[]
}

type GetPOIsPerBlindedCommitmentWireParams = ChainParams & {
  listKey: string
  blindedCommitmentDatas: BlindedCommitmentData[]
}

type POIsPerBlindedCommitmentResponse = {
  [blindedCommitment: string]: import('./types').POIStatus
}

type MerkleProof = {
  leaf: string
  elements: string[]
  indices: string
  root: string
}

type GetMerkleProofsParams = NetworkParams & {
  listKey: string
  blindedCommitments: string[]
}

type GetMerkleProofsWireParams = ChainParams & {
  listKey: string
  blindedCommitments: string[]
}

type MerkleProofsResponse = MerkleProof[]

type GetValidatedTxidParams = NetworkParams

type GetValidatedTxidWireParams = ChainParams

type ValidatedTxidResponse = {
  validatedTxidIndex: number | null
  validatedTxidMerkleroot: string | null
}

type ValidateTxidMerklerootParams = NetworkParams & {
  tree: number
  index: number
  merkleroot: string
}

type ValidateTxidMerklerootWireParams = ChainParams & {
  tree: number
  index: number
  merkleroot: string
}

type ValidatePoiMerklerootsParams = NetworkParams & {
  listKey: string
  poiMerkleroots: string[]
}

type ValidatePoiMerklerootsWireParams = ChainParams & {
  listKey: string
  poiMerkleroots: string[]
}

type SnarkProof = {
  pi_a: [string, string]
  pi_b: [[string, string], [string, string]]
  pi_c: [string, string]
}

type TransactProofData = {
  snarkProof: SnarkProof
  poiMerkleroots: string[]
  txidMerkleroot: string
  txidMerklerootIndex: number
  blindedCommitmentsOut: string[]
  railgunTxidIfHasUnshield: string
}

type SubmitTransactProofParams = NetworkParams & {
  listKey: string
  transactProofData: TransactProofData
}

type SubmitTransactProofWireParams = ChainParams & {
  listKey: string
  transactProofData: TransactProofData
}

type LegacyTransactProofData = {
  txidIndex: string
  npk: string
  value: string
  tokenHash: string
  blindedCommitment: string
}

type SubmitLegacyTransactProofsParams = NetworkParams & {
  listKeys: string[]
  legacyTransactProofDatas: LegacyTransactProofData[]
}

type SubmitLegacyTransactProofsWireParams = ChainParams & {
  listKeys: string[]
  legacyTransactProofDatas: LegacyTransactProofData[]
}

type PreTransactionPOI = {
  snarkProof: SnarkProof
  txidMerkleroot: string
  poiMerkleroots: string[]
  blindedCommitmentsOut: string[]
  railgunTxidIfHasUnshield: string
}

type PreTransactionPOIsPerTxidLeafPerList = Record<
  string,
  Record<string, PreTransactionPOI>
>

type SingleCommitmentProofsData = {
  commitment: string
  npk: string
  utxoTreeIn: number
  utxoTreeOut: number
  utxoPositionOut: number
  railgunTxid: string
  pois: PreTransactionPOIsPerTxidLeafPerList
}

type SubmitSingleCommitmentProofsParams = NetworkParams & {
  singleCommitmentProofsData: SingleCommitmentProofsData
}

type SubmitSingleCommitmentProofsWireParams = ChainParams & {
  singleCommitmentProofsData: SingleCommitmentProofsData
}

export { POIJSONRPCMethod, TXIDVersion }
export type {
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
  LegacyTransactProofData,
  MerkleProof,
  MerkleProofsResponse,
  POIsPerBlindedCommitmentResponse,
  POIsPerListResponse,
  PoiNodeClientOptions,
  PreTransactionPOI,
  PreTransactionPOIsPerTxidLeafPerList,
  SingleCommitmentProofsData,
  SnarkProof,
  SubmitLegacyTransactProofsParams,
  SubmitLegacyTransactProofsWireParams,
  SubmitSingleCommitmentProofsParams,
  SubmitSingleCommitmentProofsWireParams,
  SubmitTransactProofParams,
  SubmitTransactProofWireParams,
  TransactProofData,
  ValidatePoiMerklerootsParams,
  ValidatePoiMerklerootsWireParams,
  ValidateTxidMerklerootParams,
  ValidateTxidMerklerootWireParams,
  ValidatedTxidResponse
}
