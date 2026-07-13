import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SourceAggregator, SubsquidProvider } from '@railgun-reloaded/scanner'
import type { Address } from 'viem'
import { createPublicClient, http, parseAbi } from 'viem'

import { RailgunEngine } from '../src/engine.js'
import { NETWORK_CONFIG, NetworkName } from '../src/network-config.js'

const CONTRACT_ROOT_HISTORY_ABI = parseAbi([
  'function rootHistory(uint256, bytes32) view returns (bool)'
])
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

  const client = createPublicClient({ transport: http(networkConfig.rpcURL) })
  for (const [key, val] of noteCommitmentTrees) {
    const root = `0x${Buffer.from(val.root()).toString('hex')}` as `0x${string}`
    const hasRoot = await client.readContract({
      address: networkConfig.proxyContractAddress as Address,
      abi: CONTRACT_ROOT_HISTORY_ABI,
      functionName: 'rootHistory',
      args: [BigInt(key), root]
    })
    assert.equal(hasRoot, true)
  }
})
