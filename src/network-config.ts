import { SEPOLIA_POI_CONFIG } from './poi/network-config'
import type { NetworkPoiConfig } from './poi/network-config'

enum NetworkName {
  Ethereum = 'Ethereum',
  EthereumSepolia = 'EthereumSepolia',
  Polygon = 'Polygon',
  Arbitrum = 'Arbitrum',
  BNBChain = 'BNBChain'
}

type NetworkConfig = {
  chainID: number
  deploymentBlock: bigint
  proxyContractAddress: string
  rpcURL: string
  poi?: NetworkPoiConfig
}

const NETWORK_CONFIG : Record<NetworkName, NetworkConfig> = {
  [NetworkName.Ethereum]: {
    chainID: 1,
    deploymentBlock: 14693013n,
    proxyContractAddress: '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9',
    rpcURL: 'https://ethereum-rpc.publicnode.com'
  },
  [NetworkName.EthereumSepolia]: {
    chainID: 11155111,
    deploymentBlock: 5784866n,
    proxyContractAddress: '0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea',
    rpcURL: 'https://ethereum-sepolia-rpc.publicnode.com',
    poi: SEPOLIA_POI_CONFIG
  },
  [NetworkName.Polygon]: {
    chainID: 137,
    deploymentBlock: 27803253n,
    proxyContractAddress: '0x19b620929f97b7b990801496c3b361ca5def8c71',
    rpcURL: 'https://polygon-bor-rpc.publicnode.com'
  },
  [NetworkName.Arbitrum]: {
    chainID: 42161,
    deploymentBlock: 56109834n,
    proxyContractAddress: '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9',
    rpcURL: 'https://arbitrum-one-rpc.publicnode.com'
  },
  [NetworkName.BNBChain]: {
    chainID: 56,
    deploymentBlock: 17431925n,
    proxyContractAddress: '0x590162bf4b50f6576a459b75309ee21d92178a10',
    rpcURL: 'https://bsc-rpc.publicnode.com'
  }
}

export { NetworkName, NETWORK_CONFIG }
export type { NetworkConfig }
