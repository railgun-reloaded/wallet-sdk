import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { RailgunAddressError } from '@railgun-reloaded/0zk-addresses'
import type { ShieldCommitment } from '@railgun-reloaded/scanner'
import { createWalletDB } from '@railgun-reloaded/storage/node'
import { ShieldNote, TokenType } from '@railgun-reloaded/wallet-node'
import type { Hex, TransactionReceipt } from 'viem'
import {
  IntegerOutOfRangeError,
  bytesToHex,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  hexToBytes,
  keccak256,
  numberToBytes
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'

import { RailgunClient } from '../../src/client.js'
import {
  SHIELD_ABI,
  SHIELD_EVENT_ABI,
  SHIELD_FEE_ABI
} from '../../src/contracts/abi.js'
import {
  UnsupportedChainError,
  UnsupportedTokenTypeError
} from '../../src/contracts/index.js'
import { NETWORK_CONFIG, NetworkName } from '../../src/network-config.js'
import { deriveWalletKeys } from '../../src/services/wallet/keys.js'
import {
  SHIELD_PRIVATE_KEY_SIGNATURE_MESSAGE,
  deriveShieldPrivateKey,
  shieldPrivateKeyFromSignature
} from '../../src/shield/derivation.js'
import {
  InvalidShieldAmountError,
  InvalidShieldPrivateKeyError,
  InvalidTokenSubIDError,
  ShieldFeeReadError,
  UnexpectedShieldFieldError
} from '../../src/shield/errors.js'
import { computeShieldFee } from '../../src/shield/fee.js'
import { parseShieldReceipt, readShieldFee } from '../../src/shield/receipt.js'
import type { ShieldParams } from '../../src/shield/shield.js'
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

const ACCOUNT_ADDRESS = '0x0000000000000000000000000000000000000001'
const BLOCK_HASH = bytesToHex(new Uint8Array(32).fill(0x11))
const TX_HASH = bytesToHex(new Uint8Array(32).fill(0x22))
const EVENT_NPK = bytesToHex(new Uint8Array(32).fill(0x44))
const EVENT_SHIELD_KEY = bytesToHex(new Uint8Array(32).fill(0x55))
const EVENT_ENCRYPTED_BUNDLE: readonly [Hex, Hex, Hex] = [
  bytesToHex(new Uint8Array(32).fill(0x66)),
  bytesToHex(new Uint8Array(32).fill(0x77)),
  bytesToHex(new Uint8Array(32).fill(0x88))
]

const EVENT_COMMITMENT = {
  npk: EVENT_NPK,
  token: {
    tokenType: 0,
    tokenAddress: getAddress(TOKEN_ADDRESS),
    tokenSubID: 0n
  },
  value: 975n
}

const SHIELD_EVENT_DATA = encodeAbiParameters(
  SHIELD_EVENT_ABI[0].inputs,
  [
    2n,
    9n,
    [EVENT_COMMITMENT],
    [{ encryptedBundle: EVENT_ENCRYPTED_BUNDLE, shieldKey: EVENT_SHIELD_KEY }],
    [25n]
  ]
)

const SHIELD_EVENT_TOPICS = encodeEventTopics({
  abi: SHIELD_EVENT_ABI,
  eventName: 'Shield'
})

/**
 * Build a viem receipt containing one V2.1 Shield event.
 * @param address - Address emitting the event.
 * @param topics - Topics attached to the event log.
 * @param status - Receipt execution status.
 * @returns Complete transaction receipt for parser and client tests.
 */
const shieldReceipt = (
  address = getAddress(ETHEREUM.proxyContractAddress),
  topics: [Hex, ...Hex[]] = [SHIELD_EVENT_TOPICS[0]],
  status: 'success' | 'reverted' = 'success'
): TransactionReceipt => ({
  blockHash: BLOCK_HASH,
  blockNumber: 12n,
  contractAddress: null,
  cumulativeGasUsed: 100_000n,
  effectiveGasPrice: 1n,
  from: ACCOUNT_ADDRESS,
  gasUsed: 90_000n,
  logs: [{
    address,
    blockHash: BLOCK_HASH,
    blockNumber: 12n,
    data: SHIELD_EVENT_DATA,
    logIndex: 0,
    removed: false,
    topics,
    transactionHash: TX_HASH,
    transactionIndex: 0
  }],
  logsBloom: '0x00',
  status,
  to: getAddress(ETHEREUM.proxyContractAddress),
  transactionHash: TX_HASH,
  transactionIndex: 0,
  type: 'eip1559'
})

type NamedAbiItem = { name: string, type: string }

/**
 * Narrow an unknown JSON value to a named ABI item.
 * @param value - JSON value to inspect.
 * @returns Whether the value has string ABI `name` and `type` fields.
 */
const isNamedAbiItem = (value: unknown): value is NamedAbiItem =>
  typeof value === 'object' && value !== null &&
  'name' in value && typeof value.name === 'string' &&
  'type' in value && typeof value.type === 'string'

test('returns an unsigned transaction targeting the configured contract', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  const { transaction } = await shield(shieldParams(railgunAddress), ETHEREUM.chainID)

  assert.equal(transaction.to, getAddress(ETHEREUM.proxyContractAddress))
  assert.deepEqual(Object.keys(transaction).sort(), ['data', 'to'])
})

test('shielded note round-trips back to the recipient from the encoded calldata', async () => {
  const keys = await deriveWalletKeys(MNEMONIC)

  const { transaction } = await shield(shieldParams(keys.railgunAddress), ETHEREUM.chainID)
  const commitment = toShieldCommitment(transaction.data)

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

  const { transaction } = await shield(shieldParams(railgunAddress), ETHEREUM.chainID)
  const request = decodeRequest(transaction.data)

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

test('an ERC20 amount above uint120 is rejected', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  await assert.rejects(
    () => shield(
      { ...shieldParams(railgunAddress), amount: 2n ** 120n },
      ETHEREUM.chainID
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /uint120/)
      return true
    }
  )
})

test('a tokenSubID on an ERC20 shield is rejected before the note is constructed', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  const mixed = {
    ...shieldParams(railgunAddress),
    tokenSubID: NFT_TOKEN_SUB_ID
  } as unknown as ShieldParams

  await assert.rejects(
    () => shield(mixed, ETHEREUM.chainID),
    (error: unknown) => {
      assert.ok(error instanceof UnexpectedShieldFieldError)
      assert.equal(error.tokenType, 'ERC20')
      assert.equal(error.field, 'tokenSubID')
      return true
    }
  )
})

test('an amount on an ERC721 shield is rejected before the note is constructed', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  const mixed = {
    tokenAddress: TOKEN_ADDRESS,
    tokenType: 'ERC721',
    tokenSubID: NFT_TOKEN_SUB_ID,
    amount: AMOUNT,
    recipient: railgunAddress,
    shieldPrivateKey: SHIELD_PRIVATE_KEY
  } as unknown as ShieldParams

  await assert.rejects(
    () => shield(mixed, ETHEREUM.chainID),
    (error: unknown) => {
      assert.ok(error instanceof UnexpectedShieldFieldError)
      assert.equal(error.tokenType, 'ERC721')
      assert.equal(error.field, 'amount')
      return true
    }
  )
})

test('an unrecognized tokenType is rejected instead of defaulting to ERC20', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  for (const tokenType of ['erc721', 'ERC1155', 1, null]) {
    const params = {
      ...shieldParams(railgunAddress),
      tokenType
    } as unknown as ShieldParams

    await assert.rejects(
      () => shield(params, ETHEREUM.chainID),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedTokenTypeError)
        return true
      },
      `tokenType ${String(tokenType)} should be rejected`
    )
  }
})

test('an ERC721 tokenSubID that is not a bigint is rejected', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  for (const tokenSubID of ['', '  ', [], false, '42', 42, null, undefined]) {
    const params = {
      tokenAddress: TOKEN_ADDRESS,
      tokenType: 'ERC721',
      tokenSubID,
      recipient: railgunAddress,
      shieldPrivateKey: SHIELD_PRIVATE_KEY
    } as unknown as ShieldParams

    await assert.rejects(
      () => shield(params, ETHEREUM.chainID),
      (error: unknown) => {
        assert.ok(error instanceof InvalidTokenSubIDError)
        return true
      },
      `tokenSubID ${String(tokenSubID)} should be rejected`
    )
  }
})

test('an ERC20 amount that is not a bigint is rejected', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  for (const amount of [1000, '1000', '0x10', true, undefined, NaN]) {
    const params = {
      ...shieldParams(railgunAddress),
      amount
    } as unknown as ShieldParams

    await assert.rejects(
      () => shield(params, ETHEREUM.chainID),
      (error: unknown) => {
        assert.ok(error instanceof InvalidShieldAmountError)
        return true
      },
      `amount ${String(amount)} should be rejected`
    )
  }
})

test('an unusable shield private key is rejected', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  const unusable = [
    new Uint8Array(32),
    new Uint8Array(31).fill(9),
    new Uint8Array(33).fill(9)
  ]

  for (const shieldPrivateKey of unusable) {
    await assert.rejects(
      () => shield(
        { ...shieldParams(railgunAddress), shieldPrivateKey },
        ETHEREUM.chainID
      ),
      (error: unknown) => {
        assert.ok(error instanceof InvalidShieldPrivateKeyError)
        return true
      }
    )
  }
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

  assert.notEqual(first.transaction.data, second.transaction.data)

  const firstRequest = decodeRequest(first.transaction.data)
  const secondRequest = decodeRequest(second.transaction.data)

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

    assert.equal(
      viaClient.transaction.to,
      viaFreeFunction.transaction.to
    )

    const fromClient = decodeRequest(viaClient.transaction.data)
    const fromFreeFunction = decodeRequest(viaFreeFunction.transaction.data)

    assert.deepEqual(fromClient.preimage, fromFreeFunction.preimage)
    assert.equal(
      fromClient.ciphertext.shieldKey,
      fromFreeFunction.ciphertext.shieldKey
    )

    const recovered = await ShieldNote.fromShieldCommitment(
      toShieldCommitment(viaClient.transaction.data),
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

  const { transaction } = await shield({
    tokenAddress: TOKEN_ADDRESS,
    tokenType: 'ERC721',
    tokenSubID: NFT_TOKEN_SUB_ID,
    recipient: keys.railgunAddress,
    shieldPrivateKey: SHIELD_PRIVATE_KEY,
    random: FIXED_RANDOM
  }, ETHEREUM.chainID)

  const recovered = await ShieldNote.fromShieldCommitment(
    toShieldCommitment(transaction.data),
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

  const { transaction } = await shield({
    tokenAddress: TOKEN_ADDRESS,
    tokenType: 'ERC721',
    tokenSubID: NFT_TOKEN_SUB_ID,
    recipient: railgunAddress,
    shieldPrivateKey: SHIELD_PRIVATE_KEY,
    random: FIXED_RANDOM
  }, ETHEREUM.chainID)

  const request = decodeRequest(transaction.data)

  assert.equal(request.preimage.token.tokenType, TokenType.ERC721)
  assert.equal(request.preimage.value, 1n)
  assert.equal(request.preimage.token.tokenSubID, NFT_TOKEN_SUB_ID)
  assert.equal(request.preimage.token.tokenAddress, getAddress(TOKEN_ADDRESS))
})

test('an ERC20 shield keeps token type 0 and a zero sub-ID', async () => {
  const { railgunAddress } = await deriveWalletKeys(MNEMONIC)

  const { transaction } = await shield(shieldParams(railgunAddress), ETHEREUM.chainID)
  const request = decodeRequest(transaction.data)

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

    const { transaction } = await client.shield({
      tokenAddress: TOKEN_ADDRESS,
      tokenType: 'ERC721',
      tokenSubID: NFT_TOKEN_SUB_ID,
      recipient: keys.railgunAddress,
      shieldPrivateKey: SHIELD_PRIVATE_KEY,
      random: FIXED_RANDOM
    }, NetworkName.Ethereum)

    const request = decodeRequest(transaction.data)

    assert.equal(transaction.to, getAddress(ETHEREUM.proxyContractAddress))
    assert.equal(request.preimage.token.tokenType, TokenType.ERC721)
    assert.equal(request.preimage.token.tokenSubID, NFT_TOKEN_SUB_ID)
    assert.equal(request.preimage.value, 1n)
  } finally {
    await client.close()
  }
})

test('shield private key derivation matches keccak256 of the EIP-191 signature', async () => {
  const account = privateKeyToAccount(
    '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  )
  const signer = createWalletClient({
    account,
    chain: mainnet,
    transport: custom({
      /**
       * Reject if local account signing unexpectedly reaches the transport.
       * @returns A rejected promise.
       */
      request: async () => {
        throw new Error('Local signing should not use the transport.')
      }
    })
  })

  const signature = await account.signMessage({
    message: SHIELD_PRIVATE_KEY_SIGNATURE_MESSAGE
  })
  const expected = hexToBytes(keccak256(signature))

  assert.equal(SHIELD_PRIVATE_KEY_SIGNATURE_MESSAGE, 'RAILGUN_SHIELD')
  assert.deepEqual(await deriveShieldPrivateKey(signer), expected)
  assert.deepEqual(shieldPrivateKeyFromSignature(signature), expected)
  assert.equal(expected.length, 32)
})

test('computeShieldFee matches independently calculated inclusive ERC20 vectors', () => {
  const vectors = [
    { amount: 0n, feeBasisPoints: 0n, expectedNet: 0n, expectedFee: 0n },
    { amount: 1n, feeBasisPoints: 25n, expectedNet: 1n, expectedFee: 0n },
    { amount: 10_000n, feeBasisPoints: 1n, expectedNet: 9_999n, expectedFee: 1n },
    { amount: 10_001n, feeBasisPoints: 25n, expectedNet: 9_976n, expectedFee: 25n },
    { amount: 999_999n, feeBasisPoints: 0n, expectedNet: 999_999n, expectedFee: 0n },
    { amount: 3n, feeBasisPoints: 5_000n, expectedNet: 2n, expectedFee: 1n }
  ]

  for (const vector of vectors) {
    const result = computeShieldFee(vector.amount, vector.feeBasisPoints)
    assert.equal(result.net, vector.expectedNet)
    assert.equal(result.fee, vector.expectedFee)
  }
})

test('computeShieldFee rejects negative amounts and out-of-range contract fees', () => {
  assert.throws(() => computeShieldFee(-1n, 25n), RangeError)
  assert.throws(() => computeShieldFee(1n, -1n), RangeError)
  assert.throws(() => computeShieldFee(1n, 5_001n), RangeError)
})

test('Shield event ABI matches the five-field RailgunV2_1 contract ABI', () => {
  const abiPath = join(
    import.meta.dirname,
    '..',
    '..',
    'node_modules',
    '@railgun-reloaded',
    'contract-abis',
    'abis',
    'RailgunV2_1.json'
  )
  const parsed: unknown = JSON.parse(readFileSync(abiPath, 'utf8'))
  assert.ok(Array.isArray(parsed))
  const contractEvent = parsed.find((item: unknown) =>
    isNamedAbiItem(item) && item.type === 'event' && item.name === 'Shield'
  )
  assert.ok(contractEvent !== undefined)

  const withoutInternalTypes: unknown = JSON.parse(JSON.stringify(
    contractEvent,
    (key, value: unknown) => key === 'internalType' ? undefined : value
  ))
  assert.deepEqual(withoutInternalTypes, SHIELD_EVENT_ABI[0])
  assert.equal(SHIELD_EVENT_ABI[0].inputs.length, 5)
  assert.equal(SHIELD_EVENT_ABI[0].inputs[4].name, 'fees')
  assert.equal(SHIELD_EVENT_ABI[0].inputs[4].type, 'uint256[]')
})

test('parseShieldReceipt filters by contract and topic and returns V2.1 values', () => {
  const receipt = shieldReceipt()
  receipt.logs.unshift({
    ...receipt.logs[0]!,
    address: '0x0000000000000000000000000000000000000002'
  })
  const result = parseShieldReceipt(receipt, ETHEREUM.proxyContractAddress)

  assert.ok(result !== undefined)
  assert.equal(result.txHash, TX_HASH)
  assert.equal(result.receipt, receipt)
  assert.equal(result.treeNumber, 2n)
  assert.equal(result.startPosition, 9n)
  assert.deepEqual(result.commitment, EVENT_COMMITMENT)
  assert.equal(result.shieldedAmount, 975n)
  assert.equal(result.fee, 25n)

  assert.equal(
    parseShieldReceipt(receipt, '0x0000000000000000000000000000000000000003'),
    undefined
  )
  const wrongTopic: [Hex] = [bytesToHex(new Uint8Array(32).fill(0x99))]
  assert.equal(
    parseShieldReceipt(shieldReceipt(undefined, wrongTopic), ETHEREUM.proxyContractAddress),
    undefined
  )
})

test('readShieldFee uses the injected public client and wraps RPC failures', async () => {
  const encodedFee = encodeFunctionResult({
    abi: SHIELD_FEE_ABI,
    functionName: 'shieldFee',
    result: 25n
  })
  const publicClient = createPublicClient({
    transport: custom({
      /**
       * Return the encoded fee for the contract read.
       * @param root0 - RPC request.
       * @param root0.method - RPC method name.
       * @returns Encoded `shieldFee()` result.
       */
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_call') return encodedFee
        throw new Error(`Unexpected RPC method ${method}`)
      }
    })
  })

  assert.equal(await readShieldFee(publicClient, ETHEREUM.proxyContractAddress), 25n)

  const failingClient = createPublicClient({
    transport: custom({
      /**
       * Simulate an unavailable RPC transport.
       * @returns A rejected promise.
       */
      request: async () => {
        throw new Error('RPC unavailable')
      }
    })
  })
  await assert.rejects(
    () => readShieldFee(failingClient, ETHEREUM.proxyContractAddress),
    (error: unknown) => {
      assert.ok(error instanceof ShieldFeeReadError)
      assert.equal(error.contractAddress, getAddress(ETHEREUM.proxyContractAddress))
      return true
    }
  )
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
