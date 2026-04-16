import { poseidonFunc } from '@railgun-reloaded/cryptography'

/**
 * Poseidon hash of input
 * @param out - 32 byte segment to write hash to
 * @param left - 32 byte left element
 * @param right - 32 byte right element
 * @returns 32 bytes hash output
 */
function poseidonHash (out: Uint8Array, left: Readonly<Uint8Array>, right: Readonly<Uint8Array>) {
  // TODO: Update poseidonFunc type signature to accept Uint8Array[] instead of any
  // @ts-ignore
  const hash = poseidonFunc([left, right])
  // @ts-ignore
  out.set(hash)
  return out
}

export { poseidonHash }
