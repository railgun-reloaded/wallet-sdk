import { NoteCommitmentTree } from '@railgun-reloaded/note-commitment-indexer'
import { getMerkleTree } from '@railgun-reloaded/storage'
import { test } from 'brittle'
import { SourceAggregator, SubsquidProvider } from 'scanner'

import { RailgunEngine } from '../src/engine'
import { NetworkName } from '../src/network-config'

test('Start and Shutdown Engine', async (t) => {
  t.timeout(100_000)
  const engine = new RailgunEngine()
  const aggregator = new SourceAggregator([
    new SubsquidProvider('https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql')
  ])
  engine.setDataSource(aggregator)
  engine.setNetwork(NetworkName.EthereumSepolia)
  engine.start()
  await new Promise((resolve) => setTimeout(() => {
    engine.destroy()
    const merkleTree = getMerkleTree(engine.db!, 0)
    const tree = new NoteCommitmentTree({
      buffer: merkleTree!.leaves as Readonly<Uint8Array>,
      length: merkleTree!.leafCount
    })
    console.log(tree.root(), engine.getMerkleTreeByTreeNumber(0).root())
    resolve(true)
  }, 10_000))
})
