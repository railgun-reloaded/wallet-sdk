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

/** Thrown when the contract shield fee cannot be read through the supplied client. */
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
class ShieldSignatureRejectedError extends Error {
  /**
   * Construct a ShieldSignatureRejectedError.
   * @param cause - Original wallet signing error.
   */
  constructor (cause: unknown) {
    super('Shield private key signature was rejected or failed.', { cause })
    this.name = 'ShieldSignatureRejectedError'
  }
}

/** Thrown when a token approval transaction fails or is mined as reverted. */
class ShieldApprovalRevertedError extends Error {
  /** Token whose approval failed. */
  readonly tokenAddress: `0x${string}`

  /**
   * Construct a ShieldApprovalRevertedError.
   * @param tokenAddress - Token contract whose approval failed.
   * @param cause - Original viem/RPC error or reverted receipt.
   */
  constructor (tokenAddress: `0x${string}`, cause: unknown) {
    super(`Shield approval failed or reverted for token ${tokenAddress}.`, { cause })
    this.name = 'ShieldApprovalRevertedError'
    this.tokenAddress = tokenAddress
  }
}

/** Thrown when the shield transaction fails to submit or is mined as reverted. */
class ShieldTransactionRevertedError extends Error {
  /** Transaction hash when submission completed before the revert. */
  readonly txHash: `0x${string}` | undefined

  /**
   * Construct a ShieldTransactionRevertedError.
   * @param cause - Original viem/RPC error or reverted receipt.
   * @param txHash - Submitted transaction hash, when available.
   */
  constructor (cause: unknown, txHash?: `0x${string}`) {
    super('Shield transaction failed or reverted.', { cause })
    this.name = 'ShieldTransactionRevertedError'
    this.txHash = txHash
  }
}

/** Thrown when an approval or shield receipt exceeds viem's wait timeout. */
class ShieldReceiptTimeoutError extends Error {
  /** Transaction stage whose receipt timed out. */
  readonly stage: 'approval' | 'shield'

  /** Submitted transaction hash. */
  readonly txHash: `0x${string}`

  /**
   * Construct a ShieldReceiptTimeoutError.
   * @param stage - Approval or shield receipt stage.
   * @param txHash - Submitted transaction hash.
   * @param cause - Original viem timeout error.
   */
  constructor (
    stage: 'approval' | 'shield',
    txHash: `0x${string}`,
    cause: unknown
  ) {
    super(`Timed out waiting for the ${stage} transaction receipt ${txHash}.`, { cause })
    this.name = 'ShieldReceiptTimeoutError'
    this.stage = stage
    this.txHash = txHash
  }
}

/**
 * Thrown when a shield transaction succeeds on-chain but its receipt carries no
 * decodable Shield event.
 *
 * `parseShieldReceipt` returns `undefined` in this case because a caller may
 * legitimately hand it an unrelated receipt. For `shield()` the same state is an
 * anomaly — the transaction it just submitted and confirmed should always emit
 * the event — so it is raised rather than returned, keeping the success path
 * free of a null check.
 */
class ShieldEventMissingError extends Error {
  /** Hash of the confirmed shield transaction. */
  readonly txHash: `0x${string}`

  /** Contract address the receipt was searched against. */
  readonly contractAddress: string

  /**
   * Construct a ShieldEventMissingError.
   * @param txHash - Hash of the confirmed shield transaction.
   * @param contractAddress - Contract address the receipt was searched against.
   */
  constructor (txHash: `0x${string}`, contractAddress: string) {
    super(
      `Shield transaction ${txHash} succeeded but its receipt contains no Shield event from ${contractAddress}.`
    )
    this.name = 'ShieldEventMissingError'
    this.txHash = txHash
    this.contractAddress = contractAddress
  }
}

/** Thrown when a network has no entry in the canonical network config. */
class UnsupportedNetworkError extends Error {
  /** Network that could not be resolved to a configured deployment. */
  readonly network: string

  /**
   * Construct an UnsupportedNetworkError.
   * @param network - The network that is not configured.
   * @param supportedNetworks - Networks that are configured, listed to help
   * callers correct the argument.
   */
  constructor (network: string, supportedNetworks: readonly string[]) {
    super(
      `No RAILGUN contract configured for network ${network}. Supported networks: ${supportedNetworks.join(', ')}`
    )
    this.name = 'UnsupportedNetworkError'
    this.network = network
  }
}

export {
  InvalidShieldAmountError,
  InvalidShieldPrivateKeyError,
  InvalidTokenSubIDError,
  ShieldApprovalRevertedError,
  ShieldEventMissingError,
  ShieldFeeReadError,
  ShieldReceiptTimeoutError,
  ShieldSignatureRejectedError,
  ShieldTransactionRevertedError,
  UnexpectedShieldFieldError,
  UnsupportedNetworkError
}
