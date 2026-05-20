import { test } from 'brittle'

import { NetworkName } from '../../src/network-config'
import {
  BlindedCommitmentType,
  POIJSONRPCMethod,
  PoiNodeClient,
  TXIDVersion
} from '../../src/poi'
import type {
  FetchLike,
  FetchRequest,
  FetchResponse,
  JsonRpcRequest,
  SubmitTransactProofParams,
  TransactProofData
} from '../../src/poi'

const LIST_KEY = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88'

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

function proofFixture (): TransactProofData {
  return {
    snarkProof: {
      pi_a: ['1', '2'],
      pi_b: [['3', '4'], ['5', '6']],
      pi_c: ['7', '8']
    },
    poiMerkleroots: ['0xpoi-root'],
    txidMerkleroot: '0xtxid-root',
    txidMerklerootIndex: 4,
    blindedCommitmentsOut: ['0xout'],
    railgunTxidIfHasUnshield: '0x00'
  }
}

test('PoiNodeClient wallet-facing method payload fixtures match PPOI wire format', async (t) => {
  const payloads: Array<JsonRpcRequest<unknown>> = []
  const fetchFn: FetchLike = async (_url, request) => {
    const payload = JSON.parse(request.body) as JsonRpcRequest<unknown>
    payloads.push(payload)

    switch (payload.method) {
      case POIJSONRPCMethod.POIsPerList:
      case POIJSONRPCMethod.POIsPerBlindedCommitment:
        return jsonResponse(request, {})
      case POIJSONRPCMethod.MerkleProofs:
        return jsonResponse(request, [])
      case POIJSONRPCMethod.ValidatedTXID:
        return jsonResponse(request, {
          validatedTxidIndex: 42,
          validatedTxidMerkleroot: '0xvalidated'
        })
      case POIJSONRPCMethod.ValidateTXIDMerkleroot:
      case POIJSONRPCMethod.ValidatePOIMerkleroots:
        return jsonResponse(request, true)
      case POIJSONRPCMethod.SubmitTransactProof:
      case POIJSONRPCMethod.SubmitLegacyTransactProofs:
      case POIJSONRPCMethod.SubmitSingleCommitmentProofs:
        return jsonResponse(request, null)
    }
  }
  const client = new PoiNodeClient({
    poiNodeUrls: { [NetworkName.EthereumSepolia]: ['https://poi.example'] },
    fetchFn
  })
  const common = {
    network: NetworkName.EthereumSepolia,
    txidVersion: TXIDVersion.V2_PoseidonMerkle
  }
  const blindedCommitmentDatas = [{
    blindedCommitment: '0xabc',
    type: BlindedCommitmentType.Shield
  }]

  await client.getPOIsPerList({
    ...common,
    listKeys: [LIST_KEY],
    blindedCommitmentDatas
  })
  await client.getPOIsPerBlindedCommitment({
    ...common,
    listKey: LIST_KEY,
    blindedCommitmentDatas
  })
  await client.getMerkleProofs({
    ...common,
    listKey: LIST_KEY,
    blindedCommitments: ['0xabc']
  })
  await client.getValidatedTxid(common)
  await client.validateTxidMerkleroot({
    ...common,
    tree: 0,
    index: 42,
    merkleroot: '0xvalidated'
  })
  await client.validatePoiMerkleroots({
    ...common,
    listKey: LIST_KEY,
    poiMerkleroots: ['0xpoi-root']
  })
  await client.submitTransactProof({
    ...common,
    listKey: LIST_KEY,
    transactProofData: proofFixture()
  })
  await client.submitLegacyTransactProofs({
    ...common,
    listKeys: [LIST_KEY],
    legacyTransactProofDatas: [{
      txidIndex: '1',
      npk: '2',
      value: '3',
      tokenHash: '4',
      blindedCommitment: '0xabc'
    }]
  })
  await client.submitSingleCommitmentProofs({
    ...common,
    singleCommitmentProofsData: {
      commitment: '0xcommitment',
      npk: '0xnpk',
      utxoTreeIn: 0,
      utxoTreeOut: 1,
      utxoPositionOut: 2,
      railgunTxid: '0xrailgun-txid',
      pois: {
        [LIST_KEY]: {
          '0xtxid-leaf': {
            snarkProof: proofFixture().snarkProof,
            txidMerkleroot: '0xtxid-root',
            poiMerkleroots: ['0xpoi-root'],
            blindedCommitmentsOut: ['0xout'],
            railgunTxidIfHasUnshield: '0x00'
          }
        }
      }
    }
  })

  t.alike(payloads.map(payload => payload.method), [
    POIJSONRPCMethod.POIsPerList,
    POIJSONRPCMethod.POIsPerBlindedCommitment,
    POIJSONRPCMethod.MerkleProofs,
    POIJSONRPCMethod.ValidatedTXID,
    POIJSONRPCMethod.ValidateTXIDMerkleroot,
    POIJSONRPCMethod.ValidatePOIMerkleroots,
    POIJSONRPCMethod.SubmitTransactProof,
    POIJSONRPCMethod.SubmitLegacyTransactProofs,
    POIJSONRPCMethod.SubmitSingleCommitmentProofs
  ])

  t.alike(payloads[0]!.params, {
    chainType: '0',
    chainID: '11155111',
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    listKeys: [LIST_KEY],
    blindedCommitmentDatas
  })

  const submitPayload = payloads[6]!.params as SubmitTransactProofParams
  t.is(submitPayload.listKey, LIST_KEY)
  t.alike(Object.keys(submitPayload.transactProofData), [
    'snarkProof',
    'poiMerkleroots',
    'txidMerkleroot',
    'txidMerklerootIndex',
    'blindedCommitmentsOut',
    'railgunTxidIfHasUnshield'
  ])
})
