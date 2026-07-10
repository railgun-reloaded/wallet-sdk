import { NETWORK_CONFIG, NetworkName } from './network-config.js'
import type { SyncProgress } from './sync/wallet-decryptor.js'
import { SyncPhase } from './sync/wallet-decryptor.js'

/**
 * Build the engine `onBatch` callback that translates a per-batch
 * `(startHeight, lastBlock)` notification into a scan-phase `SyncProgress`
 * event. `startHeight` is the engine's resolved scan start (persisted
 * `syncState.lastBlockHeight + 1` or the network's deployment block), so
 * `blocksScanned` reflects the true window — not just blocks since the
 * first notification.
 * @param onProgress - Progress callback supplied to `scan()`.
 * @param endBlock - Optional inclusive ceiling set by the caller.
 * @returns Function compatible with `RailgunEngine.scan({ onBatch })`.
 */
function makeScanOnBatch (
  onProgress: (progress: SyncProgress) => void,
  endBlock?: bigint
): (startHeight: bigint, lastBlock: bigint) => void {
  return (startHeight: bigint, lastBlock: bigint) => {
    onProgress({
      phase: SyncPhase.Scan,
      fromBlock: startHeight,
      toBlock: endBlock ?? lastBlock,
      currentBlock: lastBlock,
      blocksScanned: lastBlock - startHeight + 1n,
      notesAdded: 0,
      notesSpent: 0
    })
  }
}

/**
 * Clone PPOI node URL options so caller-owned arrays are not mutated.
 * @param poiNodeUrls - Optional PPOI node URLs by network.
 * @returns Cloned PPOI node URL map.
 */
function clonePoiNodeUrls (
  poiNodeUrls: Partial<Record<NetworkName, string[]>> = {}
): Partial<Record<NetworkName, string[]>> {
  const cloned: Partial<Record<NetworkName, string[]>> = {}
  for (const network of Object.values(NetworkName) as NetworkName[]) {
    const urls = poiNodeUrls[network]
    if (urls !== undefined) {
      cloned[network] = [...urls]
    }
  }
  return cloned
}

/**
 * Check whether a network has at least one non-empty PPOI node URL.
 * @param urls - Candidate node URLs.
 * @returns True when at least one URL remains after trimming.
 */
function hasUsablePoiNodeUrls (urls: string[] | undefined): boolean {
  return urls?.some(url => url.trim().length > 0) ?? false
}

/**
 * Resolve a wallet-sdk network name from a chain ID.
 * @param chainId - EVM chain ID.
 * @returns Matching network name when configured.
 */
function findNetworkByChainId (chainId: number): NetworkName | undefined {
  return (Object.values(NetworkName) as NetworkName[])
    .find(network => NETWORK_CONFIG[network].chainID === chainId)
}

export {
  clonePoiNodeUrls,
  findNetworkByChainId,
  hasUsablePoiNodeUrls,
  makeScanOnBatch
}
