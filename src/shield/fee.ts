const BASIS_POINTS = 10_000n
const MAX_SHIELD_FEE_BASIS_POINTS = 5_000n

/**
 * Compute the inclusive ERC20 shield fee used by `RailgunLogic.getFee`.
 *
 * This helper is ERC20-only. ERC721 shields have no percentage fee and their
 * note value remains one on-chain.
 * @param amount - Inclusive ERC20 amount in token base units.
 * @param feeBasisPoints - Shield fee from the contract, from 0 through 5000.
 * @returns Net shielded amount and treasury fee.
 * @throws {RangeError} If `amount` is negative or the fee is outside 0-5000.
 */
function computeShieldFee (
  amount: bigint,
  feeBasisPoints: bigint
): { net: bigint, fee: bigint } {
  if (amount < 0n) {
    throw new RangeError('ERC20 shield amount cannot be negative.')
  }
  if (feeBasisPoints < 0n || feeBasisPoints > MAX_SHIELD_FEE_BASIS_POINTS) {
    throw new RangeError('Shield fee must be between 0 and 5000 basis points.')
  }

  const net = amount - (amount * feeBasisPoints) / BASIS_POINTS
  return { net, fee: amount - net }
}

export { computeShieldFee }
