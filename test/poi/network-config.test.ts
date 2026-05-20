import assert from 'node:assert/strict'
import { test } from 'node:test'

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

test('PPOI requirement boundary follows Sepolia launch block', () => {
  const launchBlock = SEPOLIA_POI_CONFIG.launchBlock

  assert.equal(isPOIRequired(NetworkName.EthereumSepolia, launchBlock - 1n), false)
  assert.equal(isPOIRequired(NetworkName.EthereumSepolia, launchBlock), true)
  assert.equal(isPOIRequired(NetworkName.EthereumSepolia, launchBlock + 1n), true)
})

test('non-PPOI networks never require PPOI', () => {
  assert.equal(isPOIRequired(NetworkName.Ethereum, 0n), false)
  assert.equal(isPOIRequired(NetworkName.Ethereum, 1_000_000_000n), false)
  assert.deepEqual(getRequiredListKeys(NetworkName.Ethereum), [])
})

test('Sepolia exposes PPOI config and required list keys', () => {
  assert.equal(NETWORK_CONFIG[NetworkName.EthereumSepolia].poi, SEPOLIA_POI_CONFIG)
  assert.deepEqual(getRequiredListKeys(NetworkName.EthereumSepolia), [
    CHAINALYSIS_OFAC_SANCTIONS_LIST_KEY
  ])
})

test('RailgunClient options do not require PPOI URLs at construction', () => {
  const options: RailgunClientOptions = {}

  assert.deepEqual(options, {})
})
