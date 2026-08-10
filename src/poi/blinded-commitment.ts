import { bytesToBigInt } from '@railgun-reloaded/bytes'
import { poseidonFunc } from '@railgun-reloaded/cryptography'

const BYTES_32_LENGTH = 32
const ADDRESS_LENGTH = 20

type BlindedCommitmentInputErrorCode =
  | 'InvalidBigInt'
  | 'InvalidByteLength'
  | 'InvalidByteInput'

/**
 * Input validation error for blinded commitment derivation.
 */
class BlindedCommitmentInputError extends Error {
  /** Error class name. */
  override readonly name = 'BlindedCommitmentInputError'
  /** Machine-readable validation code. */
  readonly code: BlindedCommitmentInputErrorCode
  /** Input field that failed validation. */
  readonly field: string

  /**
   * Build a typed blinded commitment input error.
   * @param code - Machine-readable validation code.
   * @param field - Input field that failed validation.
   * @param message - Human-readable validation message.
   */
  constructor (
    code: BlindedCommitmentInputErrorCode,
    field: string,
    message: string
  ) {
    super(message)
    this.code = code
    this.field = field
  }
}

type ShieldOrTransactBlindedCommitmentInput = {
  commitment: Uint8Array
  npk: bigint
  globalTreePosition: bigint
}

type UnshieldBlindedCommitmentInput = {
  railgunTxid: Uint8Array
  toAddress: Uint8Array
  value: bigint
}

/**
 * Validate a fixed-length byte input.
 * @param value - Candidate byte array.
 * @param field - Field name used in error messages.
 * @param expectedLength - Required byte length.
 * @returns The validated byte array.
 */
function assertBytesLength (
  value: Uint8Array,
  field: string,
  expectedLength: number
): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new BlindedCommitmentInputError(
      'InvalidByteInput',
      field,
      `${field} must be a Uint8Array`
    )
  }
  if (value.length !== expectedLength) {
    throw new BlindedCommitmentInputError(
      'InvalidByteLength',
      field,
      `${field} must be ${expectedLength} bytes`
    )
  }
  return value
}

/**
 * Validate a non-negative bigint input.
 * @param value - Candidate bigint value.
 * @param field - Field name used in error messages.
 * @returns The validated bigint.
 */
function assertNonNegativeBigInt (value: bigint, field: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new BlindedCommitmentInputError(
      'InvalidBigInt',
      field,
      `${field} must be a non-negative bigint`
    )
  }
  return value
}

/**
 * Derive a shield or transact blinded commitment.
 * @param input - Commitment, NPK, and global tree position.
 * @returns Derived 32-byte blinded commitment.
 */
function getBlindedCommitmentForShieldOrTransact (
  input: ShieldOrTransactBlindedCommitmentInput
): Uint8Array {
  const commitment = assertBytesLength(
    input.commitment,
    'commitment',
    BYTES_32_LENGTH
  )
  const npk = assertNonNegativeBigInt(input.npk, 'npk')
  const globalTreePosition = assertNonNegativeBigInt(
    input.globalTreePosition,
    'globalTreePosition'
  )

  return poseidonFunc([
    bytesToBigInt(commitment),
    npk,
    globalTreePosition
  ]) as Uint8Array
}

/**
 * Derive an unshield blinded commitment.
 * @param input - Unshield railgun TXID and public output data.
 * @returns The unshield blinded commitment bytes.
 */
function getBlindedCommitmentForUnshield (
  input: UnshieldBlindedCommitmentInput
): Uint8Array {
  const railgunTxid = assertBytesLength(
    input.railgunTxid,
    'railgunTxid',
    BYTES_32_LENGTH
  )
  assertBytesLength(input.toAddress, 'toAddress', ADDRESS_LENGTH)
  assertNonNegativeBigInt(input.value, 'value')

  return new Uint8Array(railgunTxid)
}

export {
  BlindedCommitmentInputError,
  getBlindedCommitmentForShieldOrTransact,
  getBlindedCommitmentForUnshield
}
export type {
  BlindedCommitmentInputErrorCode,
  ShieldOrTransactBlindedCommitmentInput,
  UnshieldBlindedCommitmentInput
}
