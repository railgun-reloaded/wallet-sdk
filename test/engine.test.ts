import { SourceAggregator, SubsquidProvider } from '@railgun-reloaded/scanner'
import { test } from 'brittle'
import { Contract, JsonRpcProvider } from 'ethers'

import { RailgunEngine } from '../src/engine'
import { NETWORK_CONFIG, NetworkName } from '../src/network-config'

const CONTRACT_ROOT_HISTORY_ABI = [
  'function rootHistory(uint256, bytes32) view returns (bool)'
]
const networkName = NetworkName.EthereumSepolia

test('Should create NoteCommitmentTree and verify root', async (t) => {
  t.timeout(60_000)
  const engine = new RailgunEngine()
  const aggregator = new SourceAggregator([
    new SubsquidProvider('https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql')
  ])
  engine.setDataSource(aggregator)
  engine.setNetwork(networkName)

  const networkConfig = NETWORK_CONFIG[networkName]
  const endBlock = networkConfig.deploymentBlock + 200_000n
  await engine.scan({ endBlock })

  const noteCommitmentTrees = engine.getAllNoteCommitmentTree()
  engine.destroy()

  const provider = new JsonRpcProvider(networkConfig.rpcURL)
  const contract = new Contract(networkConfig.proxyContractAddress, CONTRACT_ROOT_HISTORY_ABI, provider)
  for (const [key, val] of noteCommitmentTrees) {
    const root = `0x${Buffer.from(val.root()).toString('hex')}`
    // @ts-ignore should be always present for valid ABI
    t.is(await contract.rootHistory(key, root), true)
  }
})
