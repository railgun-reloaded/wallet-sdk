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

export { InvalidShieldAmountError }
