import { test } from 'brittle'
import { SourceAggregator, SubsquidProvider } from 'scanner'

import { RailgunEngine } from '../src/engine'
import { NetworkName } from '../src/network-config'

test.skip('Start and Shutdown Engine', async (t) => {
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
    resolve(true)
  }, 10_000))
})
