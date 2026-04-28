import { bigIntToBytes } from '@railgun-reloaded/bytes'

/**
 * Decode a decimal or `0x`-prefixed hex string as a fixed-length big-endian
 * byte array. Test helper kept for compatibility with existing fixtures.
 * @param ns - Decimal or hex numeric string.
 * @param length - Target byte length.
 * @returns Big-endian byte array of exactly `length` bytes.
 */
function numberStringToUint8Array (ns: string, length: number): Uint8Array {
  return bigIntToBytes(BigInt(ns), length)
}

export { numberStringToUint8Array }
