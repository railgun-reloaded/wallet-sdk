import type { NetworkName } from '../network-config'

import { POIListType } from './types'
import type { POIList, RequiredListKey } from './types'

type NetworkPoiConfig = {
  launchBlock: bigint
  launchTimestamp: number
  requiredListKeys: RequiredListKey[]
}

const CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY =
  'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88'

const SEPOLIA_REQUIRED_POI_LISTS: POIList[] = [
  {
    key: CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY,
    type: POIListType.Active,
    name: 'Chainalysis OFAC Sanctions API',
    description:
      'API used to restrict bad actors designated by the US Department of the Treasury.'
  }
]

const SEPOLIA_REQUIRED_LIST_KEYS = SEPOLIA_REQUIRED_POI_LISTS
  .filter(list => list.type === POIListType.Active)
  .map(list => list.key)

const SEPOLIA_POI_CONFIG: NetworkPoiConfig = {
  launchBlock: 5944700n,
  launchTimestamp: 1716309480,
  requiredListKeys: SEPOLIA_REQUIRED_LIST_KEYS
}

const POI_CONFIG_BY_NETWORK: Partial<Record<NetworkName, NetworkPoiConfig>> = {
  EthereumSepolia: SEPOLIA_POI_CONFIG
}

function getPoiConfig (network: NetworkName): NetworkPoiConfig | undefined {
  return POI_CONFIG_BY_NETWORK[network]
}

function isPOIRequired (
  network: NetworkName,
  blockNumber: bigint
): boolean {
  const config = getPoiConfig(network)
  return config !== undefined && blockNumber >= config.launchBlock
}

function getRequiredListKeys (network: NetworkName): RequiredListKey[] {
  return [...(getPoiConfig(network)?.requiredListKeys ?? [])]
}

export {
  CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY,
  SEPOLIA_POI_CONFIG,
  SEPOLIA_REQUIRED_LIST_KEYS,
  SEPOLIA_REQUIRED_POI_LISTS,
  getRequiredListKeys,
  isPOIRequired
}
export type { NetworkPoiConfig }
