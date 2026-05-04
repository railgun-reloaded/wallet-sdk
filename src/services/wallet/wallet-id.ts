import { bytesToHex, hexToBytes } from '@railgun-reloaded/bytes'
import { sha256 } from '@railgun-reloaded/cryptography'
import { Mnemonic } from '@railgun-reloaded/wallet-node'

/**
 * Derive the deterministic wallet ID for a (mnemonic, index) pair.
 *
 * Matches the production engine exactly:
 *   sha256(mnemonicSeed || bytes(index.toString(16)))
 *
 * 0.toString(16) === "0" is deterministic, so "0" and "00" never collide.
 * @param mnemonic - BIP39 mnemonic phrase.
 * @param index - BIP44-style derivation index (default 0). Enables multi-
 *   account from the same seed.
 * @returns Unprefixed lowercase hex (64 chars).
 */
function generateWalletId (mnemonic: string, index: number = 0): string {
  const seed = Mnemonic.toSeed(mnemonic)

  const rawHex = index.toString(16)
  const paddedHex = rawHex.length % 2 === 0 ? rawHex : `0${rawHex}`
  const indexBytes = hexToBytes(paddedHex)

  const combined = new Uint8Array(seed.length + indexBytes.length)
  combined.set(seed, 0)
  combined.set(indexBytes, seed.length)

  return bytesToHex(sha256(combined))
}

export { generateWalletId }
