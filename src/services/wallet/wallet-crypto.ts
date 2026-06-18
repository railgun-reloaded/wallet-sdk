import { combine } from '@railgun-reloaded/bytes'
import { AES } from '@railgun-reloaded/cryptography'

import { InvalidEncryptionKeyError } from './errors.js'

/**
 * The plaintext structure stored inside the encrypted wallet blob. Keeping
 * mnemonic + index (rather than derived keys) lets us rotate the encryption
 * key simply by re-encrypting the same blob.
 */
type WalletBlob = {
  mnemonic: string
  index: number
}

const IV_LENGTH = 16
const TAG_LENGTH = 16

/**
 * Encrypt a wallet blob with AES-256-GCM.
 *
 * Wire format: iv (16B) || tag (16B) || ciphertext (variable).
 * @param blob - Plaintext wallet data to encrypt.
 * @param encryptionKey - 32-byte caller-supplied key. KDF is caller policy.
 * @returns Packed ciphertext ready for storage.
 * @throws InvalidEncryptionKeyError when `encryptionKey.length !== 32`.
 */
function encryptWalletBlob (blob: WalletBlob, encryptionKey: Uint8Array): Buffer {
  assertKeyLength(encryptionKey)

  const plaintext = new TextEncoder().encode(JSON.stringify(blob))
  const { iv, tag, data } = AES.encryptGCM([plaintext], encryptionKey)
  const ciphertext = combine(data)

  const out = Buffer.alloc(IV_LENGTH + TAG_LENGTH + ciphertext.length)
  out.set(iv, 0)
  out.set(tag, IV_LENGTH)
  out.set(ciphertext, IV_LENGTH + TAG_LENGTH)
  return out
}

/**
 * Decrypt a wallet blob. Authenticates via the AES-GCM tag.
 *
 * All failure modes (wrong key, bit-flipped ciphertext, truncation,
 * malformed post-decrypt JSON) collapse into InvalidEncryptionKeyError so
 * callers don't get a side-channel for distinguishing them.
 * @param packed - The iv||tag||ciphertext packed buffer.
 * @param encryptionKey - 32-byte key that was used to encrypt.
 * @returns The original WalletBlob.
 * @throws InvalidEncryptionKeyError on any decryption failure.
 */
function decryptWalletBlob (packed: Uint8Array, encryptionKey: Uint8Array): WalletBlob {
  assertKeyLength(encryptionKey)

  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new InvalidEncryptionKeyError('Wallet blob is truncated')
  }

  const iv = packed.subarray(0, IV_LENGTH)
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH)

  let plaintext: Uint8Array
  try {
    const decrypted = AES.decryptGCM({ iv, tag, data: [ciphertext] }, encryptionKey)
    plaintext = combine(decrypted)
  } catch (cause) {
    throw new InvalidEncryptionKeyError('AES-GCM authentication failed', { cause })
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as WalletBlob
    if (typeof parsed.mnemonic !== 'string' || typeof parsed.index !== 'number') {
      throw new Error('Decrypted blob is missing required fields')
    }
    return parsed
  } catch (cause) {
    throw new InvalidEncryptionKeyError('Decrypted wallet blob is malformed', { cause })
  }
}

/**
 * Assert that an encryption key is exactly 32 bytes.
 * @param key - Key to validate.
 * @throws InvalidEncryptionKeyError when length is anything other than 32.
 */
function assertKeyLength (key: Uint8Array): void {
  if (key.length !== 32) {
    throw new InvalidEncryptionKeyError(
      `encryptionKey must be 32 bytes, received ${key.length}`
    )
  }
}

export { encryptWalletBlob, decryptWalletBlob }
export type { WalletBlob }
