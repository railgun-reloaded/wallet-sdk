import { bytesToBigInt } from '@railgun-reloaded/bytes'
import { poseidonFunc } from '@railgun-reloaded/cryptography'

import { BlindedCommitmentType } from './types'

const BYTES_32_LENGTH = 32
const ADDRESS_LENGTH = 20

type BlindedCommitmentInputErrorCode =
  | 'InvalidBigInt'
  | 'InvalidByteLength'
  | 'InvalidByteInput'
  | 'InvalidType'

class BlindedCommitmentInputError extends Error {
  override readonly name = 'BlindedCommitmentInputError'
  readonly code: BlindedCommitmentInputErrorCode
  readonly field: string

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

type BlindedCommitmentInput =
  | ({ type: BlindedCommitmentType.Shield } & ShieldOrTransactBlindedCommitmentInput)
  | ({ type: BlindedCommitmentType.Transact } & ShieldOrTransactBlindedCommitmentInput)
  | ({ type: BlindedCommitmentType.Unshield } & UnshieldBlindedCommitmentInput)

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

function getBlindedCommitment (
  input: BlindedCommitmentInput
): Uint8Array {
  switch (input.type) {
    case BlindedCommitmentType.Shield:
    case BlindedCommitmentType.Transact:
      return getBlindedCommitmentForShieldOrTransact(input)
    case BlindedCommitmentType.Unshield:
      return getBlindedCommitmentForUnshield(input)
    default:
      throw new BlindedCommitmentInputError(
        'InvalidType',
        'type',
        'Invalid blinded commitment type'
      )
  }
}

export {
  BlindedCommitmentInputError,
  getBlindedCommitment,
  getBlindedCommitmentForShieldOrTransact,
  getBlindedCommitmentForUnshield
}
export type {
  BlindedCommitmentInput,
  BlindedCommitmentInputErrorCode,
  ShieldOrTransactBlindedCommitmentInput,
  UnshieldBlindedCommitmentInput
}
