import path from 'node:path'

/**
 * Resolve the trusted chain database path for a network.
 * @param dataDir - Wallet-sdk data directory.
 * @param chainID - Network chain ID.
 * @returns Absolute chain.db path.
 */
function getWalletChainDBPath (dataDir: string, chainID: number): string {
  return path.resolve(dataDir, 'chains', `${chainID}`, 'chain.db')
}

export { getWalletChainDBPath }
