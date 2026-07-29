import { parse } from '@railgun-reloaded/0zk-addresses'
import { ShieldNote, TokenType, buildShieldRequest } from '@railgun-reloaded/wallet-node'
import { getAddress, hexToBytes, numberToBytes } from 'viem'

import type { UnsignedTx } from '../contracts/index.js'
import { buildShieldTransaction } from '../contracts/index.js'

import { InvalidShieldAmountError, UnexpectedShieldFieldError } from './errors.js'

/** Byte length of the token sub-ID field. */
const TOKEN_SUB_ID_BYTES = 32

/** Note value of an ERC721 shield: a single, indivisible token. */
const ERC721_NOTE_VALUE = 1n

/**
 * Inputs shared by every shield, regardless of token standard.
 */
type ShieldBaseParams = {
  /** Address of the token contract being shielded. */
  tokenAddress: `0x${string}`

  /** 0zk address receiving the shielded note. */
  recipient: string

  /**
   * 32 bytes obtained by signing the shield key derivation message. Used to
   * encrypt the note random to the recipient's viewing key.
   */
  shieldPrivateKey: Uint8Array

  /**
   * 16-byte note random. Supplied only to make tests deterministic; normal
   * callers omit it so each shield gets a fresh random. Reusing a random
   * across shields makes the resulting notes linkable.
   */
  random?: Uint8Array | undefined
}

/**
 * Inputs for shielding a fungible ERC20 balance.
 */
type ShieldErc20Params = ShieldBaseParams & {
  /** Token standard being shielded. Defaults to ERC20 when omitted. */
  tokenType?: 'ERC20' | undefined

  /** Amount to shield in the token's base units. Must be positive. */
  amount: bigint

  /** Not applicable to ERC20: fungible balances carry no token identifier. */
  tokenSubID?: never
}

/**
 * Inputs for shielding a single ERC721 token.
 */
type ShieldErc721Params = ShieldBaseParams & {
  /** Token standard being shielded. */
  tokenType: 'ERC721'

  /**
   * Identifier of the token being shielded, as a uint256. The note value is
   * always one, so there is no amount to supply.
   */
  tokenSubID: bigint

  /** Not applicable to ERC721: the note value is always one. */
  amount?: never
}

/**
 * Inputs for `shield()`, discriminated by `tokenType`.
 */
type ShieldParams = ShieldErc20Params | ShieldErc721Params

/**
 * Result of `shield()`.
 */
type ShieldResult = {
  /** Unsigned transaction to sign and send. */
  transaction: UnsignedTx
}

/**
 * Resolve the note value and token fields for the requested token standard.
 *
 * Runs before any note is constructed, so mismatched fields, invalid amounts,
 * and out-of-range token identifiers are all rejected up front. A field that
 * belongs to the other token standard is an error rather than an ignored
 * input.
 * @param params - Shield inputs.
 * @returns The note value plus the token type and sub-ID bytes.
 * @throws {UnexpectedShieldFieldError} If a field belongs to the other token standard.
 * @throws {InvalidShieldAmountError} If an ERC20 amount is not positive.
 * @throws {IntegerOutOfRangeError} If an ERC721 sub-ID is not a uint256.
 */
const resolveToken = (params: ShieldParams) => {
  if (params.tokenType === 'ERC721') {
    if (params.amount !== undefined) {
      throw new UnexpectedShieldFieldError('ERC721', 'amount')
    }

    return {
      value: ERC721_NOTE_VALUE,
      tokenType: TokenType.ERC721,
      tokenSubID: numberToBytes(params.tokenSubID, { size: TOKEN_SUB_ID_BYTES })
    }
  }

  if (params.tokenSubID !== undefined) {
    throw new UnexpectedShieldFieldError('ERC20', 'tokenSubID')
  }

  // TODO: Relay Adapt shields use a zero value to mean "shield the entire
  // balance", where the shielding contract supplies the amount at execution
  // time. Relax this guard for that path when it is added.
  if (params.amount <= 0n) {
    throw new InvalidShieldAmountError(params.amount)
  }

  return {
    value: params.amount,
    tokenType: TokenType.ERC20,
    tokenSubID: new Uint8Array(TOKEN_SUB_ID_BYTES)
  }
}

/**
 * Builds an unsigned transaction that shields ERC20 or ERC721 tokens into a
 * private note for a 0zk recipient.
 *
 * `tokenType` selects the standard and defaults to ERC20. An ERC20 shield takes
 * an `amount`; an ERC721 shield takes a `tokenSubID` and always has a note value
 * of one. The note carries the full amount and the shield fee is deducted
 * on-chain, so there is no fee parameter. The returned transaction is unsigned
 * and carries no gas, nonce, or signer fields.
 *
 * The token standard is taken at face value and never verified against the
 * contract, because this function performs no network access. Passing a token
 * address whose standard does not match `tokenType` produces a transaction that
 * fails on-chain.
 *
 * Requires the cryptography libraries to be initialized first.
 *
 * Callers are responsible for the steps around this call: deriving
 * `shieldPrivateKey` by signing the shield key derivation message, granting the
 * RAILGUN contract an allowance or approval for the token, estimating gas,
 * signing, and sending. This function never signs or sends.
 * @param params - Token, recipient, and shield private key.
 * @param chainId - Chain whose RAILGUN contract receives the shield.
 * @returns The unsigned shield transaction.
 * @throws {UnexpectedShieldFieldError} If a field belongs to the other token standard.
 * @throws {InvalidShieldAmountError} If an ERC20 amount is not positive.
 * @throws {IntegerOutOfRangeError} If an ERC721 sub-ID is not a uint256.
 * @throws {Error} If an ERC20 amount does not fit the contract's uint120 field.
 * @throws {Error} If `random` is supplied and is not 16 bytes.
 * @throws {RailgunAddressError} If `recipient` is not a valid 0zk address.
 * @throws {InvalidAddressError} If `tokenAddress` is not a valid address.
 * @throws {UnsupportedChainError} If the chain has no configured contract.
 */
const shield = async (
  params: ShieldParams,
  chainId: number
): Promise<ShieldResult> => {
  const { random, recipient, shieldPrivateKey, tokenAddress } = params

  const { tokenSubID, tokenType, value } = resolveToken(params)

  const { masterPublicKey, viewingPublicKey } = parse(recipient)
  const tokenAddressBytes = hexToBytes(getAddress(tokenAddress))

  const note = ShieldNote.create({
    masterPublicKey,
    value,
    tokenData: {
      tokenType,
      tokenAddress: tokenAddressBytes,
      tokenSubID
    },
    random
  })

  const request = await buildShieldRequest(
    note,
    shieldPrivateKey,
    viewingPublicKey
  )

  return { transaction: buildShieldTransaction([request], chainId) }
}

export { shield }
export type {
  ShieldBaseParams,
  ShieldErc20Params,
  ShieldErc721Params,
  ShieldParams,
  ShieldResult
}
