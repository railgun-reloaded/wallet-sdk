import { test } from 'brittle'

import type { RailgunClientOptions } from '../../src/client'
import {
  NETWORK_CONFIG,
  NetworkName
} from '../../src/network-config'
import {
  CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY,
  SEPOLIA_POI_CONFIG,
  getRequiredListKeys,
  isPOIRequired
} from '../../src/poi'

test('PPOI requirement boundary follows Sepolia launch block', (t) => {
  const launchBlock = SEPOLIA_POI_CONFIG.launchBlock

  t.is(isPOIRequired(NetworkName.EthereumSepolia, launchBlock - 1n), false)
  t.is(isPOIRequired(NetworkName.EthereumSepolia, launchBlock), true)
  t.is(isPOIRequired(NetworkName.EthereumSepolia, launchBlock + 1n), true)
})

test('non-PPOI networks never require PPOI', (t) => {
  t.is(isPOIRequired(NetworkName.Ethereum, 0n), false)
  t.is(isPOIRequired(NetworkName.Ethereum, 1_000_000_000n), false)
  t.alike(getRequiredListKeys(NetworkName.Ethereum), [])
})

test('Sepolia exposes PPOI config and required list keys', (t) => {
  t.is(NETWORK_CONFIG[NetworkName.EthereumSepolia].poi, SEPOLIA_POI_CONFIG)
  t.alike(getRequiredListKeys(NetworkName.EthereumSepolia), [
    CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY
  ])
})

test('RailgunClient options do not require PPOI URLs at construction', (t) => {
  const options: RailgunClientOptions = {}

  t.alike(options, {})
})
