import type { ShieldRequest } from '@railgun-reloaded/wallet-node'
import { TokenType } from '@railgun-reloaded/wallet-node'
import {
  bytesToBigInt,
  bytesToHex,
  encodeFunctionData,
  getAddress
} from 'viem'

import type { NetworkConfig } from '../network-config.js'
import { NETWORK_CONFIG } from '../network-config.js'

import { SHIELD_ABI } from './abi.js'
import { UnsupportedChainError, UnsupportedTokenTypeError } from './errors.js'

/**
 * An unsigned transaction: the call target and its encoded calldata. Carries
 * no gas, nonce, or signer fields, so callers estimate gas and sign with their
 * own wallet client.
 */
type UnsignedTx = {
  to: `0x${string}`
  data: `0x${string}`
}

/** Chain ID to network config, indexed once from `NETWORK_CONFIG`. */
const CONFIG_BY_CHAIN_ID: ReadonlyMap<number, NetworkConfig> = new Map(
  Object.values(NETWORK_CONFIG).map((config) => [config.chainID, config])
)

/**
 * Resolves the RAILGUN contract address for a chain.
 * @param chainId - Chain ID to resolve.
 * @returns The checksummed contract address.
 * @throws {UnsupportedChainError} If the chain has no configured contract.
 */
const resolveContractAddress = (chainId: number): `0x${string}` => {
  const config = CONFIG_BY_CHAIN_ID.get(chainId)
  if (config === undefined) {
    throw new UnsupportedChainError(chainId, [...CONFIG_BY_CHAIN_ID.keys()])
  }
  return getAddress(config.proxyContractAddress)
}

/**
 * Normalizes a byte-oriented shield request into the ABI shape the contract
 * expects: bytes32 fields become 0x-prefixed hex, the token address is
 * checksummed, and the token sub-ID is decoded to an unsigned integer.
 * @param request - The shield request to normalize.
 * @returns The request in ABI-encodable form.
 * @throws {UnsupportedTokenTypeError} If the token type is not ERC20 or ERC721.
 */
const toAbiShieldRequest = (request: ShieldRequest) => {
  const { preimage, ciphertext } = request
  const { tokenType } = preimage.token

  if (tokenType !== TokenType.ERC20 && tokenType !== TokenType.ERC721) {
    throw new UnsupportedTokenTypeError(tokenType)
  }

  const [bundle0, bundle1, bundle2] = ciphertext.encryptedBundle

  return {
    preimage: {
      npk: bytesToHex(preimage.npk),
      token: {
        tokenType,
        tokenAddress: getAddress(bytesToHex(preimage.token.tokenAddress)),
        tokenSubID: bytesToBigInt(preimage.token.tokenSubID)
      },
      value: preimage.value
    },
    ciphertext: {
      encryptedBundle: [
        bytesToHex(bundle0),
        bytesToHex(bundle1),
        bytesToHex(bundle2)
      ] as const,
      shieldKey: bytesToHex(ciphertext.shieldKey)
    }
  }
}

/**
 * Builds an unsigned `shield` transaction for the RAILGUN contract on a chain.
 *
 * The result is ready to hand to a wallet client for gas estimation, signing,
 * and sending; this function performs no network access.
 * @param requests - Shield requests to submit in a single call.
 * @param chainId - Chain to build the transaction for.
 * @returns The call target and encoded calldata.
 * @throws {UnsupportedChainError} If the chain has no configured contract.
 * @throws {UnsupportedTokenTypeError} If a request carries an unsupported token type.
 */
const buildShieldTransaction = (
  requests: ShieldRequest[],
  chainId: number
): UnsignedTx => {
  const to = resolveContractAddress(chainId)
  const data = encodeFunctionData({
    abi: SHIELD_ABI,
    functionName: 'shield',
    args: [requests.map(toAbiShieldRequest)]
  })

  return { to, data }
}

export { buildShieldTransaction }
export type { UnsignedTx }
