/**
 * Thrown when a shield is requested for an amount that cannot be represented
 * as a note value. Shield amounts must be positive bigints.
 */
class InvalidShieldAmountError extends Error {
  /** The amount that was rejected, as supplied by the caller. */
  readonly amount: unknown

  /**
   * Construct an InvalidShieldAmountError.
   * @param amount - The rejected shield amount.
   */
  constructor (amount: unknown) {
    super(`Shield amount must be a positive bigint. Got ${String(amount)}.`)
    this.name = 'InvalidShieldAmountError'
    this.amount = amount
  }
}

/**
 * Thrown when an ERC721 shield is requested for a token identifier that is not
 * a bigint. Values are never coerced, because coercing an empty or unset input
 * would silently shield token zero.
 */
class InvalidTokenSubIDError extends Error {
  /** The token identifier that was rejected, as supplied by the caller. */
  readonly tokenSubID: unknown

  /**
   * Construct an InvalidTokenSubIDError.
   * @param tokenSubID - The rejected token identifier.
   */
  constructor (tokenSubID: unknown) {
    super(`ERC721 tokenSubID must be a bigint. Got ${String(tokenSubID)}.`)
    this.name = 'InvalidTokenSubIDError'
    this.tokenSubID = tokenSubID
  }
}

/**
 * Thrown when the shield private key is not 32 usable bytes. An all-zero key is
 * rejected because it is guessable: anyone could then decrypt the shield
 * ciphertext and recover the note random and the recipient's viewing key.
 */
class InvalidShieldPrivateKeyError extends Error {
  /**
   * Construct an InvalidShieldPrivateKeyError.
   * @param reason - Why the supplied key was rejected.
   */
  constructor (reason: string) {
    super(`Shield private key is unusable: ${reason}.`)
    this.name = 'InvalidShieldPrivateKeyError'
  }
}

/**
 * Thrown when shield inputs carry a field belonging to a different token
 * standard, such as a `tokenSubID` on an ERC20 shield. The field cannot be
 * honoured, so it is rejected rather than silently dropped.
 */
class UnexpectedShieldFieldError extends Error {
  /** Token standard the shield was requested for. */
  readonly tokenType: 'ERC20' | 'ERC721'

  /** Field that does not belong to that token standard. */
  readonly field: 'amount' | 'tokenSubID'

  /**
   * Construct an UnexpectedShieldFieldError.
   * @param tokenType - Token standard the shield was requested for.
   * @param field - Field that does not belong to that token standard.
   */
  constructor (tokenType: 'ERC20' | 'ERC721', field: 'amount' | 'tokenSubID') {
    super(`An ${tokenType} shield cannot carry a ${field}.`)
    this.name = 'UnexpectedShieldFieldError'
    this.tokenType = tokenType
    this.field = field
  }
}

/**
 * Thrown when reading the shield fee from the RAILGUN contract fails.
 *
 * Wraps the underlying transport error so callers can distinguish an RPC
 * problem from a contract that returned an unusable value.
 */
class ShieldFeeReadError extends Error {
  /** Contract address whose fee read failed. */
  readonly contractAddress: `0x${string}`

  /**
   * Construct a ShieldFeeReadError.
   * @param contractAddress - Contract whose `shieldFee()` call failed.
   * @param cause - Original viem/RPC error.
   */
  constructor (contractAddress: `0x${string}`, cause: unknown) {
    super(`Failed to read shield fee from ${contractAddress}.`, { cause })
    this.name = 'ShieldFeeReadError'
    this.contractAddress = contractAddress
  }
}

/** Thrown when the wallet rejects or fails shield key signature derivation. */

export {
  InvalidShieldAmountError,
  InvalidShieldPrivateKeyError,
  InvalidTokenSubIDError,
  ShieldFeeReadError,
  UnexpectedShieldFieldError
}
