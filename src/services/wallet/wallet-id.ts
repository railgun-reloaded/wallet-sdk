import { bytesToHex, hexToBytes } from '@railgun-reloaded/bytes'
import { sha256 } from '@railgun-reloaded/cryptography'
import { Mnemonic } from '@railgun-reloaded/wallet-node'

/**
 * Highest usable derivation index. BIP-32 hardened derivation adds `0x80000000`
 * to the index and writes the sum as a uint32, so anything above this wraps and
 * derives the keys of a lower index.
 */
const MAX_WALLET_DERIVATION_INDEX = 0x7fffffff

/**
 * Reject a derivation index that BIP-32 cannot represent. Without this an index
 * above the maximum wraps to a lower one, producing a distinct wallet ID that
 * shares its keys and 0zk address with another wallet.
 * @param index - Derivation index to check.
 * @throws RangeError When `index` is not an integer in the derivable range.
 */
function assertDerivationIndex (index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_WALLET_DERIVATION_INDEX) {
    throw new RangeError(
      `index must be an integer between 0 and ${MAX_WALLET_DERIVATION_INDEX}`
    )
  }
}

/**
 * Derive the deterministic wallet ID for a (mnemonic, index) pair:
 *   sha256(mnemonicSeed || bytes(index.toString(16)))
 *
 * 0.toString(16) === "0" is deterministic, so "0" and "00" never collide.
 * @param mnemonic - BIP39 mnemonic phrase.
 * @param index - BIP44-style derivation index (default 0). Enables multi-
 *   account from the same seed.
 * @returns Unprefixed lowercase hex (64 chars).
 * @throws RangeError When `index` is not an integer in the derivable range.
 */
function generateWalletId (mnemonic: string, index: number = 0): string {
  assertDerivationIndex(index)

  const seed = Mnemonic.toSeed(mnemonic)

  const rawHex = index.toString(16)
  const paddedHex = rawHex.length % 2 === 0 ? rawHex : `0${rawHex}`
  const indexBytes = hexToBytes(paddedHex)

  const combined = new Uint8Array(seed.length + indexBytes.length)
  combined.set(seed, 0)
  combined.set(indexBytes, seed.length)

  return bytesToHex(sha256(combined))
}

export { MAX_WALLET_DERIVATION_INDEX, assertDerivationIndex, generateWalletId }
