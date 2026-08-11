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
 * Canonical metadata for a supported network. Deployment fields are protocol
 * facts; `rpcURL` is an SDK-selected default endpoint that may rotate.
 * Caller-selected service endpoints remain external: pass the indexer endpoint
 * to `createDataSource` and PPOI node URLs through
 * `RailgunClientOptions.poiNodeUrls`.
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

/** Thrown when a network has no entry in the canonical network config. */
class UnsupportedNetworkError extends Error {
  /** Network that could not be resolved to a configured deployment. */
  readonly network: string

  /**
   * Construct an UnsupportedNetworkError.
   * @param network - The network that is not configured.
   * @param supportedNetworks - Networks that are configured, listed to help
   * callers correct the argument.
   */
  constructor (network: string, supportedNetworks: readonly string[]) {
    super(
      `No RAILGUN contract configured for network ${network}. Supported networks: ${supportedNetworks.join(', ')}`
    )
    this.name = 'UnsupportedNetworkError'
    this.network = network
  }
}

export { NetworkName, NETWORK_CONFIG, UnsupportedNetworkError }
export type { NetworkConfig }
