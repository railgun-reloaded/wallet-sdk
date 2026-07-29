/**
 * Thrown when a shield is requested for an amount that cannot be represented
 * as a note value. Shield amounts must be positive.
 */
class InvalidShieldAmountError extends Error {
  /** The amount that was rejected. */
  readonly amount: bigint

  /**
   * Construct an InvalidShieldAmountError.
   * @param amount - The rejected shield amount.
   */
  constructor (amount: bigint) {
    super(`Shield amount must be positive. Got ${amount}.`)
    this.name = 'InvalidShieldAmountError'
    this.amount = amount
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

export { InvalidShieldAmountError, UnexpectedShieldFieldError }
