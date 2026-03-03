enum NetworkName {
  EthereumSepolia = 'EthereumSepolia'
}

const NETWORK_CONFIG : Record<NetworkName, any> = {
  [NetworkName.EthereumSepolia]: {
    deploymentBlock: 5784866n,
    proxyContractAddress: '0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea'
  }
}

export { NetworkName, NETWORK_CONFIG }
