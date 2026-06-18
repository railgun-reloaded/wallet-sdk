import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SourceAggregator, SubsquidProvider } from '@railgun-reloaded/scanner'
import { Contract, JsonRpcProvider } from 'ethers'

import { RailgunEngine } from '../src/engine.js'
import { NETWORK_CONFIG, NetworkName } from '../src/network-config.js'

const CONTRACT_ROOT_HISTORY_ABI = [
  'function rootHistory(uint256, bytes32) view returns (bool)'
]
const networkName = NetworkName.EthereumSepolia

test('Should create NoteCommitmentTree and verify root', { timeout: 60_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wallet-sdk-engine-'))
  const engine = new RailgunEngine({ dataDir })
  t.after(async () => {
    await engine.destroy()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const aggregator = new SourceAggregator([
    new SubsquidProvider('https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql')
  ])
  engine.setDataSource(aggregator)
  await engine.setNetwork(networkName)

  const networkConfig = NETWORK_CONFIG[networkName]
  const endBlock = networkConfig.deploymentBlock + 200_000n
  await engine.scan({ endBlock })

  const noteCommitmentTrees = engine.getAllNoteCommitmentTree()

  const provider = new JsonRpcProvider(networkConfig.rpcURL)
  const contract = new Contract(networkConfig.proxyContractAddress, CONTRACT_ROOT_HISTORY_ABI, provider)
  for (const [key, val] of noteCommitmentTrees) {
    const root = `0x${Buffer.from(val.root()).toString('hex')}`
    // @ts-ignore should be always present for valid ABI
    assert.equal(await contract.rootHistory(key, root), true)
  }
})
