import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { RailgunAddressError } from '@railgun-reloaded/0zk-addresses'
import type { ShieldCommitment } from '@railgun-reloaded/scanner'
import { createWalletDB } from '@railgun-reloaded/storage/node'
import { ShieldNote, TokenType } from '@railgun-reloaded/wallet-node'
import {
  IntegerOutOfRangeError,
  bytesToHex,
  decodeFunctionData,
  getAddress,
  hexToBytes,
  numberToBytes
} from 'viem'

import { RailgunClient } from '../../src/client.js'
import { SHIELD_ABI } from '../../src/contracts/abi.js'
import { UnsupportedChainError } from '../../src/contracts/index.js'
import { NETWORK_CONFIG, NetworkName } from '../../src/network-config.js'
import { deriveWalletKeys } from '../../src/services/wallet/keys.js'
import { InvalidShieldAmountError } from '../../src/shield/errors.js'
import { shield } from '../../src/shield/shield.js'
import { MNEMONIC } from '../fixtures/wallet-vectors.js'

const TOKEN_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const AMOUNT = 1_000_000n
const FIXED_RANDOM = new Uint8Array(16).fill(7)
const SHIELD_PRIVATE_KEY = new Uint8Array(32).fill(9)
const ETHEREUM = NETWORK_CONFIG[NetworkName.Ethereum]
const NFT_TOKEN_SUB_ID = 42n

const TOKEN_TYPE_NAMES: Record<number, string> = {
  [TokenType.ERC20]: 'ERC20',
  [TokenType.ERC721]: 'ERC721'
}

/**
 * Decode the single shield request carried by shield calldata.
 * @param data - Encoded shield calldata.
 * @returns The decoded shield request struct.
 */
const decodeRequest = (data: `0x${string}`) => {
  const decoded = decodeFunctionData({ abi: SHIELD_ABI, data })
  assert.equal(decoded.functionName, 'shield')

  const [requests] = decoded.args
  assert.equal(requests.length, 1)

  return requests[0]!
}

/**
 * Rebuild the on-chain ShieldCommitment that shield calldata would produce, so
 * the note can be recovered the way a chain scanner recovers it.
 * @param data - Encoded shield calldata.
 * @returns The equivalent shield commitment.
 */
const toShieldCommitment = (data: `0x${string}`): ShieldCommitment => {
  const request = decodeRequest(data)

  return {
    hash: new Uint8Array(32),
    treeNumber: 0,
    treePosition: 0,
    preimage: {
      npk: hexToBytes(request.preimage.npk),
      token: {
        id: new Uint8Array(32),
        tokenType: TOKEN_TYPE_NAMES[request.preimage.token.tokenType]!,
        tokenAddress: hexToBytes(request.preimage.token.tokenAddress),
        tokenSubID: numberToBytes(request.preimage.token.tokenSubID, { size: 32 })
      },
      value: request.preimage.value
    },
    encryptedBundle: request.ciphertext.encryptedBundle.map((part) => hexToBytes(part)),
    shieldKey: hexToBytes(request.ciphertext.shieldKey)
  }
}

/**
 * Build the shield inputs for a recipient, pinning the note random so the
 * recovered note is deterministic. The surrounding calldata is not: the AES
 * initialization vectors inside the shield request are generated per call.
 * @param recipient - 0zk address receiving the note.
 * @returns Shield parameters for the Ethereum mainnet contract.
 */
const shieldParams = (recipient: string) => ({
  tokenAddress: TOKEN_ADDRESS as `0x${string}`,
  amount: AMOUNT,
  recipient,
  shieldPrivateKey: SHIELD_PRIVATE_KEY,
  random: FIXED_RANDOM
})

test('returns a single unsigned transaction targeting the configured contract', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  const { transactions } = await shield(shieldParams(railgunAddress), ETHEREUM.chainID)

  assert.equal(transactions.length, 1)

  const tx = transactions[0]!
  assert.equal(tx.to, getAddress(ETHEREUM.proxyContractAddress))
  assert.deepEqual(Object.keys(tx).sort(), ['data', 'to'])
})

test('shielded note round-trips back to the recipient from the encoded calldata', async () => {
  const keys = await deriveWalletKeys(MNEMONIC)

  const { transactions } = await shield(shieldParams(keys.railgunAddress), ETHEREUM.chainID)
  const commitment = toShieldCommitment(transactions[0]!.data)

  const recovered = await ShieldNote.fromShieldCommitment(
    commitment,
    keys.viewingPrivateKey,
    keys.masterPublicKey
  )

  assert.ok(recovered !== null)
  assert.equal(recovered.value, AMOUNT)
  assert.equal(recovered.tokenData.tokenType, TokenType.ERC20)
  assert.equal(bytesToHex(recovered.tokenData.tokenAddress), TOKEN_ADDRESS)
  assert.equal(recovered.random, bytesToHex(FIXED_RANDOM))
})

test('the encoded request carries the full pre-fee amount and ERC20 token', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  const { transactions } = await shield(shieldParams(railgunAddress), ETHEREUM.chainID)
  const request = decodeRequest(transactions[0]!.data)

  assert.equal(request.preimage.value, AMOUNT)
  assert.equal(request.preimage.token.tokenType, TokenType.ERC20)
  assert.equal(request.preimage.token.tokenAddress, getAddress(TOKEN_ADDRESS))
  assert.equal(request.preimage.token.tokenSubID, 0n)
})

test('an invalid 0zk recipient is rejected before the note is constructed', async () => {
  await assert.rejects(
    () => shield(shieldParams('not-a-railgun-address'), ETHEREUM.chainID),
    (error: unknown) => {
      assert.ok(error instanceof RailgunAddressError)
      return true
    }
  )
})

test('a well-formed address with a corrupt checksum is rejected', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)
  const corrupted = `${railgunAddress.slice(0, -1)}${railgunAddress.endsWith('q') ? 'p' : 'q'}`

  await assert.rejects(
    () => shield(shieldParams(corrupted), ETHEREUM.chainID),
    (error: unknown) => {
      assert.ok(error instanceof RailgunAddressError)
      return true
    }
  )
})

test('a zero amount is rejected before the note is constructed', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  await assert.rejects(
    () => shield({ ...shieldParams(railgunAddress), amount: 0n }, ETHEREUM.chainID),
    (error: unknown) => {
      assert.ok(error instanceof InvalidShieldAmountError)
      assert.equal(error.amount, 0n)
      return true
    }
  )
})

test('a negative amount is rejected before the note is constructed', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  await assert.rejects(
    () => shield({ ...shieldParams(railgunAddress), amount: -1n }, ETHEREUM.chainID),
    (error: unknown) => {
      assert.ok(error instanceof InvalidShieldAmountError)
      assert.equal(error.amount, -1n)
      return true
    }
  )
})

test('an unconfigured chain is rejected', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  await assert.rejects(
    () => shield(shieldParams(railgunAddress), 1337),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedChainError)
      assert.equal(error.chainId, 1337)
      return true
    }
  )
})

test('consecutive shields with identical inputs produce different ciphertexts', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  const params = {
    tokenAddress: TOKEN_ADDRESS as `0x${string}`,
    amount: AMOUNT,
    recipient: railgunAddress,
    shieldPrivateKey: SHIELD_PRIVATE_KEY
  }

  const first = await shield(params, ETHEREUM.chainID)
  const second = await shield(params, ETHEREUM.chainID)

  assert.notEqual(first.transactions[0]!.data, second.transactions[0]!.data)

  const firstRequest = decodeRequest(first.transactions[0]!.data)
  const secondRequest = decodeRequest(second.transactions[0]!.data)

  assert.notDeepEqual(
    [...firstRequest.ciphertext.encryptedBundle],
    [...secondRequest.ciphertext.encryptedBundle]
  )
  assert.notEqual(firstRequest.preimage.npk, secondRequest.preimage.npk)

  assert.equal(firstRequest.preimage.value, secondRequest.preimage.value)
  assert.equal(
    firstRequest.preimage.token.tokenAddress,
    secondRequest.preimage.token.tokenAddress
  )
})

test('client.shield resolves the network and delegates to the shield free function', async () => {
  const walletDB = await createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
  const client = await RailgunClient.create({ walletDB })

  try {
    const keys = await deriveWalletKeys(MNEMONIC)

    const viaClient = await client.shield({
      tokenAddress: TOKEN_ADDRESS,
      amount: AMOUNT,
      recipient: keys.railgunAddress,
      shieldPrivateKey: SHIELD_PRIVATE_KEY,
      random: FIXED_RANDOM
    }, NetworkName.Ethereum)

    const viaFreeFunction = await shield(shieldParams(keys.railgunAddress), ETHEREUM.chainID)

    assert.equal(viaClient.transactions.length, 1)
    assert.equal(
      viaClient.transactions[0]!.to,
      viaFreeFunction.transactions[0]!.to
    )

    const fromClient = decodeRequest(viaClient.transactions[0]!.data)
    const fromFreeFunction = decodeRequest(viaFreeFunction.transactions[0]!.data)

    assert.deepEqual(fromClient.preimage, fromFreeFunction.preimage)
    assert.equal(
      fromClient.ciphertext.shieldKey,
      fromFreeFunction.ciphertext.shieldKey
    )

    const recovered = await ShieldNote.fromShieldCommitment(
      toShieldCommitment(viaClient.transactions[0]!.data),
      keys.viewingPrivateKey,
      keys.masterPublicKey
    )

    assert.ok(recovered !== null)
    assert.equal(recovered.value, AMOUNT)
    assert.equal(recovered.random, bytesToHex(FIXED_RANDOM))
  } finally {
    await client.close()
  }
})

test('an ERC721 note round-trips back with its token identifier', async () => {
  const keys = await deriveWalletKeys(MNEMONIC)

  const { transactions } = await shield({
    tokenAddress: TOKEN_ADDRESS,
    tokenType: 'ERC721',
    tokenSubID: NFT_TOKEN_SUB_ID,
    recipient: keys.railgunAddress,
    shieldPrivateKey: SHIELD_PRIVATE_KEY,
    random: FIXED_RANDOM
  }, ETHEREUM.chainID)

  const recovered = await ShieldNote.fromShieldCommitment(
    toShieldCommitment(transactions[0]!.data),
    keys.viewingPrivateKey,
    keys.masterPublicKey
  )

  assert.ok(recovered !== null)
  assert.equal(recovered.tokenData.tokenType, TokenType.ERC721)
  assert.equal(recovered.value, 1n)
  assert.equal(bytesToHex(recovered.tokenData.tokenAddress), TOKEN_ADDRESS)
  assert.deepEqual(
    recovered.tokenData.tokenSubID,
    numberToBytes(NFT_TOKEN_SUB_ID, { size: 32 })
  )
})

test('an ERC721 shield encodes token type 1, a value of one, and the sub-ID', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  const { transactions } = await shield({
    tokenAddress: TOKEN_ADDRESS,
    tokenType: 'ERC721',
    tokenSubID: NFT_TOKEN_SUB_ID,
    recipient: railgunAddress,
    shieldPrivateKey: SHIELD_PRIVATE_KEY,
    random: FIXED_RANDOM
  }, ETHEREUM.chainID)

  const request = decodeRequest(transactions[0]!.data)

  assert.equal(request.preimage.token.tokenType, TokenType.ERC721)
  assert.equal(request.preimage.value, 1n)
  assert.equal(request.preimage.token.tokenSubID, NFT_TOKEN_SUB_ID)
  assert.equal(request.preimage.token.tokenAddress, getAddress(TOKEN_ADDRESS))
})

test('an ERC20 shield keeps token type 0 and a zero sub-ID', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  const { transactions } = await shield(shieldParams(railgunAddress), ETHEREUM.chainID)
  const request = decodeRequest(transactions[0]!.data)

  assert.equal(request.preimage.token.tokenType, TokenType.ERC20)
  assert.equal(request.preimage.token.tokenSubID, 0n)
})

test('an ERC721 sub-ID outside uint256 is rejected before construction', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  for (const tokenSubID of [2n ** 256n, -1n]) {
    await assert.rejects(
      () => shield({
        tokenAddress: TOKEN_ADDRESS,
        tokenType: 'ERC721',
        tokenSubID,
        recipient: railgunAddress,
        shieldPrivateKey: SHIELD_PRIVATE_KEY
      }, ETHEREUM.chainID),
      (error: unknown) => {
        assert.ok(error instanceof IntegerOutOfRangeError)
        return true
      }
    )
  }
})

test('client.shield shields an ERC721 through the network selector', async () => {
  const walletDB = await createWalletDB({
    path: ':memory:',
    runMigrations: true,
    migrationsFolder: '../storage/drizzle/wallet'
  })
  const client = await RailgunClient.create({ walletDB })

  try {
    const keys = await deriveWalletKeys(MNEMONIC)

    const { transactions } = await client.shield({
      tokenAddress: TOKEN_ADDRESS,
      tokenType: 'ERC721',
      tokenSubID: NFT_TOKEN_SUB_ID,
      recipient: keys.railgunAddress,
      shieldPrivateKey: SHIELD_PRIVATE_KEY,
      random: FIXED_RANDOM
    }, NetworkName.Ethereum)

    const request = decodeRequest(transactions[0]!.data)

    assert.equal(transactions[0]!.to, getAddress(ETHEREUM.proxyContractAddress))
    assert.equal(request.preimage.token.tokenType, TokenType.ERC721)
    assert.equal(request.preimage.token.tokenSubID, NFT_TOKEN_SUB_ID)
    assert.equal(request.preimage.value, 1n)
  } finally {
    await client.close()
  }
})

test('shield module imports no Node built-ins', () => {
  const shieldDir = join(import.meta.dirname, '..', '..', 'src', 'shield')
  const sources = readdirSync(shieldDir).filter((file) => file.endsWith('.ts'))
  assert.ok(sources.length > 0)

  const nodeOnly = new Set(['fs', 'path', 'crypto', 'os', 'url', 'buffer'])

  for (const file of sources) {
    const contents = readFileSync(join(shieldDir, file), 'utf8')
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
