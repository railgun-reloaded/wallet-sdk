import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bytesToHex, createPublicClient, custom, encodeFunctionResult, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  Mnemonic as BrowserMnemonic,
  createDataSource as createBrowserDataSource,
  readShieldFeeForNetwork as readBrowserShieldFeeForNetwork
} from '../src/browser/index.js'
import { SHIELD_FEE_ABI } from '../src/contracts/abi.js'
import {
  Mnemonic,
  NETWORK_CONFIG,
  NetworkName,
  UnsupportedNetworkError,
  createDataSource,
  readShieldFeeForNetwork
} from '../src/index.js'
import {
  Mnemonic as NodeMnemonic,
  createDataSource as createNodeDataSource,
  readShieldFeeForNetwork as readNodeShieldFeeForNetwork
} from '../src/node/index.js'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const SEPOLIA_INDEXER_URL =
  'https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql'

test('Mnemonic leaf export derives an Ethereum signing account from every entry', () => {
  assert.equal(BrowserMnemonic, Mnemonic)
  assert.equal(NodeMnemonic, Mnemonic)

  const privateKey = Mnemonic.to0xPrivateKey(TEST_MNEMONIC)
  const account = privateKeyToAccount(bytesToHex(privateKey))

  assert.equal(account.address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
})

test('readShieldFeeForNetwork resolves the configured proxy from every entry', async () => {
  assert.equal(readBrowserShieldFeeForNetwork, readShieldFeeForNetwork)
  assert.equal(readNodeShieldFeeForNetwork, readShieldFeeForNetwork)

  const encodedFee = encodeFunctionResult({
    abi: SHIELD_FEE_ABI,
    functionName: 'shieldFee',
    result: 25n
  })
  let requestedParams: readonly unknown[] | undefined
  const publicClient = createPublicClient({
    transport: custom({
      /**
       * Return the encoded fee and capture the contract call.
       * @param request - RPC request to handle.
       * @param request.method - RPC method name.
       * @param request.params - RPC method parameters.
       * @returns Encoded `shieldFee()` result.
       */
      request: async (request: {
        method: string
        params?: readonly unknown[] | undefined
      }) => {
        if (request.method === 'eth_call') {
          requestedParams = request.params
          return encodedFee
        }
        throw new Error(`Unexpected RPC method ${request.method}`)
      }
    })
  })

  assert.equal(
    await readShieldFeeForNetwork(publicClient, NetworkName.EthereumSepolia),
    25n
  )
  assert.ok(Array.isArray(requestedParams))
  const call = requestedParams[0]
  assert.ok(typeof call === 'object' && call !== null && 'to' in call)
  assert.equal(
    call.to,
    getAddress(NETWORK_CONFIG[NetworkName.EthereumSepolia].proxyContractAddress)
  )
})

test('createDataSource wires the supplied endpoint through every entry', async () => {
  assert.equal(createBrowserDataSource, createDataSource)
  assert.equal(createNodeDataSource, createDataSource)

  const originalFetch = globalThis.fetch
  const source = createDataSource(SEPOLIA_INDEXER_URL)
  let requestedURL: string | URL | Request | undefined
  /**
   * Return a successful mocked Subsquid head response.
   * @param input - Request URL to capture.
   * @returns Mocked Subsquid response.
   */
  globalThis.fetch = async (input) => {
    requestedURL = input
    return new Response(JSON.stringify({
      data: { squidStatus: { height: '0' } }
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200
    })
  }

  try {
    const iterator = source.from({
      startHeight: 1n,
      endHeight: 1n,
      liveSync: false
    })
    assert.deepEqual(await iterator.next(), { done: true, value: undefined })
    assert.equal(requestedURL, SEPOLIA_INDEXER_URL)
  } finally {
    globalThis.fetch = originalFetch
    source.destroy()
  }
})

test('readShieldFeeForNetwork rejects an unconfigured network with a typed error', async () => {
  await assert.rejects(
    readShieldFeeForNetwork({} as never, 'Optimism'),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedNetworkError)
      assert.equal(error.network, 'Optimism')
      return true
    }
  )
})

test('network config carries protocol facts, not caller-supplied service endpoints', () => {
  for (const network of Object.values(NetworkName)) {
    const config = NETWORK_CONFIG[network]
    assert.equal(typeof config.chainID, 'number')
    assert.equal(typeof config.proxyContractAddress, 'string')
    assert.ok(!('indexerURL' in config), `${network} must not pin an indexer endpoint`)
    assert.ok(!('poiNodeURL' in config), `${network} must not pin a PPOI node endpoint`)
  }
})
