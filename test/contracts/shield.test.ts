import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { hexToBytes } from '@railgun-reloaded/bytes'
import type { ShieldRequest } from '@railgun-reloaded/wallet-node'
import { decodeFunctionData, getAddress, toFunctionSelector } from 'viem'

import { SHIELD_ABI, SHIELD_FUNCTION_SIGNATURE } from '../../src/contracts/abi.js'
import {
  UnsupportedChainError,
  UnsupportedTokenTypeError,
  buildShieldTransaction
} from '../../src/contracts/index.js'
import { NETWORK_CONFIG } from '../../src/network-config.js'
import type { ShieldRequestVector } from '../fixtures/shield-calldata.js'
import {
  SHIELD_CALLDATA,
  SHIELD_REQUESTS,
  SHIELD_SELECTOR
} from '../fixtures/shield-calldata.js'

/**
 * Converts a hex-string fixture vector into the byte-oriented shield request
 * the encoder accepts.
 * @param vector - Fixture vector with hex-encoded byte fields.
 * @returns The equivalent shield request.
 */
const toShieldRequest = (vector: ShieldRequestVector): ShieldRequest => {
  const [bundle0, bundle1, bundle2] = vector.ciphertext.encryptedBundle
  return {
    preimage: {
      npk: hexToBytes(vector.preimage.npk),
      token: {
        tokenType: vector.preimage.token.tokenType,
        tokenAddress: hexToBytes(vector.preimage.token.tokenAddress),
        tokenSubID: hexToBytes(vector.preimage.token.tokenSubID)
      },
      value: BigInt(vector.preimage.value)
    },
    ciphertext: {
      encryptedBundle: [
        hexToBytes(bundle0),
        hexToBytes(bundle1),
        hexToBytes(bundle2)
      ],
      shieldKey: hexToBytes(vector.ciphertext.shieldKey)
    }
  }
}

const FIXTURE_REQUESTS = SHIELD_REQUESTS.map(toShieldRequest)
const ETHEREUM_CHAIN_ID = NETWORK_CONFIG.Ethereum.chainID

test('selector derives from the Solidity signature', () => {
  const derived = toFunctionSelector(SHIELD_FUNCTION_SIGNATURE)

  assert.equal(derived, SHIELD_SELECTOR)

  const { data } = buildShieldTransaction(FIXTURE_REQUESTS, ETHEREUM_CHAIN_ID)
  assert.ok(data.startsWith(derived))
})

test('calldata is byte-identical to the independently encoded reference', () => {
  const { data } = buildShieldTransaction(FIXTURE_REQUESTS, ETHEREUM_CHAIN_ID)

  assert.equal(data, SHIELD_CALLDATA)
})

test('calldata round-trips back to the normalized struct values', () => {
  const { data } = buildShieldTransaction(FIXTURE_REQUESTS, ETHEREUM_CHAIN_ID)

  const decoded = decodeFunctionData({ abi: SHIELD_ABI, data })
  assert.equal(decoded.functionName, 'shield')

  const [decodedRequests] = decoded.args
  assert.equal(decodedRequests.length, SHIELD_REQUESTS.length)

  decodedRequests.forEach((decodedRequest, index) => {
    const vector = SHIELD_REQUESTS[index]!

    assert.equal(decodedRequest.preimage.npk, vector.preimage.npk)
    assert.equal(decodedRequest.preimage.value, BigInt(vector.preimage.value))
    assert.equal(decodedRequest.preimage.token.tokenType, vector.preimage.token.tokenType)
    assert.equal(
      decodedRequest.preimage.token.tokenAddress,
      getAddress(vector.preimage.token.tokenAddress)
    )
    assert.equal(
      decodedRequest.preimage.token.tokenSubID,
      BigInt(vector.preimage.token.tokenSubID)
    )
    assert.deepEqual(
      [...decodedRequest.ciphertext.encryptedBundle],
      vector.ciphertext.encryptedBundle
    )
    assert.equal(decodedRequest.ciphertext.shieldKey, vector.ciphertext.shieldKey)
  })
})

test('resolves the configured contract address for every supported chain', () => {
  const networks = Object.values(NETWORK_CONFIG)
  assert.ok(networks.length > 0)

  for (const network of networks) {
    const { to } = buildShieldTransaction(FIXTURE_REQUESTS, network.chainID)

    assert.equal(to, getAddress(network.proxyContractAddress))
  }
})

test('throws a descriptive error for an unconfigured chain', () => {
  assert.throws(
    () => buildShieldTransaction(FIXTURE_REQUESTS, 1337),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedChainError)
      assert.equal(error.chainId, 1337)
      assert.match(error.message, /1337/)
      assert.match(error.message, new RegExp(String(ETHEREUM_CHAIN_ID)))
      return true
    }
  )
})

test('throws for a token type outside ERC20 and ERC721', () => {
  const unsupported = structuredClone(FIXTURE_REQUESTS[0]!)
  unsupported.preimage.token.tokenType = 2

  assert.throws(
    () => buildShieldTransaction([unsupported], ETHEREUM_CHAIN_ID),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedTokenTypeError)
      assert.equal(error.tokenType, 2)
      return true
    }
  )
})

test('rejects a value that does not fit uint120', () => {
  const overflowing = structuredClone(FIXTURE_REQUESTS[0]!)
  overflowing.preimage.value = 2n ** 120n

  assert.throws(() => buildShieldTransaction([overflowing], ETHEREUM_CHAIN_ID))
})

test('returns only the call target and calldata', () => {
  const tx = buildShieldTransaction(FIXTURE_REQUESTS, ETHEREUM_CHAIN_ID)

  assert.deepEqual(Object.keys(tx).sort(), ['data', 'to'])
})

test('contract module imports no Node built-ins', () => {
  const contractsDir = join(import.meta.dirname, '..', '..', 'src', 'contracts')
  const sources = readdirSync(contractsDir).filter((file) => file.endsWith('.ts'))
  assert.ok(sources.length > 0)

  const nodeOnly = new Set(['fs', 'path', 'crypto', 'os', 'url', 'buffer'])

  for (const file of sources) {
    const contents = readFileSync(join(contractsDir, file), 'utf8')
    const specifiers = [...contents.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!)

    for (const specifier of specifiers) {
      assert.ok(
        !specifier.startsWith('node:'),
        `${file} imports Node built-in '${specifier}'`
      )
      assert.ok(
        !nodeOnly.has(specifier),
        `${file} imports Node built-in '${specifier}'`
      )
    }
  }
})
