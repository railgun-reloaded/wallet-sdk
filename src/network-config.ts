enum NetworkName {
  EthereumSepolia = 'EthereumSepolia'
}

type NetworkConfig = {
  chainID: number
  deploymentBlock: bigint
  proxyContractAddress: string
}

const NETWORK_CONFIG : Record<NetworkName, NetworkConfig> = {
  [NetworkName.EthereumSepolia]: {
    chainID: 11155111,
    deploymentBlock: 5784866n,
    proxyContractAddress: '0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea'
  }
}

export { NetworkName, NETWORK_CONFIG }
export type { NetworkConfig }
