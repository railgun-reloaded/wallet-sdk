import type { NetworkPoiConfig } from './poi/network-config.js'
import { SEPOLIA_POI_CONFIG } from './poi/network-config.js'

enum NetworkName {
  Ethereum = 'Ethereum',
  EthereumSepolia = 'EthereumSepolia',
  Polygon = 'Polygon',
  Arbitrum = 'Arbitrum',
  BNBChain = 'BNBChain'
}

/**
 * Canonical protocol deployment metadata for a supported network. Every field
 * here is a fact about the deployment itself.
 *
 * Service endpoints are deliberately absent. Both the indexer endpoint and the
 * PPOI node URL name a hosted service that an operator chooses, runs, and can
 * rotate or self-host, so neither belongs to the protocol and neither should
 * ship on an SDK release cycle. Callers pass their indexer endpoint to
 * `createDataSource` and their PPOI nodes through
 * `RailgunClientOptions.poiNodeUrls`. The public Subsquid squid for Sepolia is
 * `https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql`, named
 * here only so a first integration knows where to point.
 */
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
    proxyContractAddress: '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9',
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
    proxyContractAddress: '0x19B620929f97b7b990801496c3b361CA5dEf8C71',
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
    proxyContractAddress: '0x590162bf4b50F6576a459B75309eE21D92178A10',
    rpcURL: 'https://bsc-rpc.publicnode.com'
  }
}

export { NetworkName, NETWORK_CONFIG }
export type { NetworkConfig }
