import type {
  Address,
  Hash,
  Hex,
  PublicClient,
  TransactionReceipt
} from 'viem'
import {
  decodeEventLog,
  getAddress,
  isAddressEqual,
  toEventSelector
} from 'viem'

import { SHIELD_EVENT_ABI, SHIELD_FEE_ABI } from '../contracts/abi.js'
import type { NetworkName } from '../network-config.js'
import { NETWORK_CONFIG, UnsupportedNetworkError } from '../network-config.js'

import { ShieldFeeReadError } from './errors.js'

type ShieldCommitmentPreimage = {
  npk: Hex
  token: {
    tokenType: number
    tokenAddress: Address
    tokenSubID: bigint
  }
  value: bigint
}

type ShieldReceiptResult = {
  txHash: Hash
  receipt: TransactionReceipt
  treeNumber: bigint
  startPosition: bigint
  commitment: ShieldCommitmentPreimage
  shieldedAmount: bigint
  fee: bigint
}

const SHIELD_EVENT_TOPIC = toEventSelector(SHIELD_EVENT_ABI[0])

/**
 * Decode the first V2.1 Shield event emitted by a specific contract.
 * @param receipt - Confirmed transaction receipt to inspect.
 * @param contractAddress - RAILGUN proxy address expected to emit the event.
 * @returns Parsed shield details, or `undefined` when no address-and-topic
 * match exists or the matching event contains no commitment.
 */
function parseShieldReceipt (
  receipt: TransactionReceipt,
  contractAddress: string
): ShieldReceiptResult | undefined {
  const expectedAddress = getAddress(contractAddress)
  const log = receipt.logs.find((candidate) =>
    isAddressEqual(candidate.address, expectedAddress) &&
    candidate.topics[0] === SHIELD_EVENT_TOPIC
  )

  if (log === undefined) {
    return undefined
  }

  const decoded = decodeEventLog({
    abi: SHIELD_EVENT_ABI,
    data: log.data,
    topics: log.topics
  })
  const commitment = decoded.args.commitments[0]
  if (commitment === undefined) {
    return undefined
  }

  return {
    txHash: receipt.transactionHash,
    receipt,
    treeNumber: decoded.args.treeNumber,
    startPosition: decoded.args.startPosition,
    commitment,
    shieldedAmount: commitment.value,
    fee: decoded.args.fees[0] ?? 0n
  }
}

/**
 * Read the current ERC20 shield fee from an injected viem public client.
 * @param publicClient - Caller-owned public client for the target chain.
 * @param contractAddress - RAILGUN proxy address exposing `shieldFee()`.
 * @returns Shield fee in basis points.
 * @throws {ShieldFeeReadError} If the RPC or contract read fails.
 */
async function readShieldFee (
  publicClient: PublicClient,
  contractAddress: string
): Promise<bigint> {
  const address = getAddress(contractAddress)
  try {
    return await publicClient.readContract({
      address,
      abi: SHIELD_FEE_ABI,
      functionName: 'shieldFee'
    })
  } catch (cause) {
    throw new ShieldFeeReadError(address, cause)
  }
}

/**
 * Read the current ERC20 shield fee for a configured network. The RAILGUN
 * proxy address is resolved from `NETWORK_CONFIG`, so callers pass a network
 * rather than a contract address.
 * @param publicClient - Caller-owned public client for the target chain.
 * @param network - Network name to validate against the configured deployments.
 * @returns Shield fee in basis points.
 * @throws {UnsupportedNetworkError} If the network has no configured contract.
 * @throws {ShieldFeeReadError} If the RPC or contract read fails.
 */
async function readShieldFeeForNetwork (
  publicClient: PublicClient,
  network: NetworkName | (string & {})
): Promise<bigint> {
  const config = NETWORK_CONFIG[network as NetworkName]
  if (config === undefined) {
    throw new UnsupportedNetworkError(network, Object.keys(NETWORK_CONFIG))
  }
  return readShieldFee(publicClient, config.proxyContractAddress)
}

export { parseShieldReceipt, readShieldFee, readShieldFeeForNetwork }
export type { ShieldCommitmentPreimage, ShieldReceiptResult }
