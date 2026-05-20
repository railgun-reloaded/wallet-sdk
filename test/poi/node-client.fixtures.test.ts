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
  JsonRpcRequest
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

test('PoiNodeClient read-side payload fixture matches PPOI wire format', async (t) => {
  const payloads: Array<JsonRpcRequest<unknown>> = []
  const fetchFn: FetchLike = async (_url, request) => {
    const payload = JSON.parse(request.body) as JsonRpcRequest<unknown>
    payloads.push(payload)
    return jsonResponse(request, {})
  }
  const client = new PoiNodeClient({
    poiNodeUrls: { [NetworkName.EthereumSepolia]: ['https://poi.example'] },
    fetchFn
  })
  const blindedCommitmentDatas = [{
    blindedCommitment: '0xabc',
    type: BlindedCommitmentType.Shield
  }]

  await client.getPOIsPerList({
    network: NetworkName.EthereumSepolia,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    listKeys: [LIST_KEY],
    blindedCommitmentDatas
  })

  t.alike(payloads.map(payload => payload.method), [
    POIJSONRPCMethod.POIsPerList
  ])
  t.alike(payloads[0]!.params, {
    chainType: '0',
    chainID: '11155111',
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    listKeys: [LIST_KEY],
    blindedCommitmentDatas
  })
})
