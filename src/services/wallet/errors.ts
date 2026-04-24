/**
 * Thrown when a mnemonic fails BIP39 validation (word count, checksum, or
 * unknown word).
 */
class InvalidMnemonicError extends Error {
  /**
   * Construct an InvalidMnemonicError with an optional custom message.
   * @param message - Optional override; defaults to a generic validation error.
   */
  constructor (message = 'Mnemonic failed BIP39 validation') {
    super(message)
    this.name = 'InvalidMnemonicError'
  }
}

/**
 * Thrown when the provided encryption key is not 32 bytes OR when AES-GCM
 * authentication fails on decrypt (wrong key or tampered ciphertext). Callers
 * see a single failure mode for both, since they're indistinguishable from
 * outside.
 */
class InvalidEncryptionKeyError extends Error {
  /**
   * Construct an InvalidEncryptionKeyError.
   * @param message - Optional custom message.
   * @param options - Optional `{ cause }` to preserve the underlying error.
   */
  constructor (
    message = 'Encryption key invalid (wrong length or decryption auth failure)',
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'InvalidEncryptionKeyError'
  }
}

/**
 * Thrown by createWallet when a wallet with the same (mnemonic, index) pair
 * already exists. The existing walletId is exposed on the error so callers
 * can fall back to loadWallet without recomputing it.
 */
class WalletAlreadyExistsError extends Error {
  /** Deterministic ID of the already-existing wallet. */
  readonly walletId: string

  /**
   * Construct a WalletAlreadyExistsError.
   * @param walletId - ID of the wallet that already exists in the store.
   */
  constructor (walletId: string) {
    super(`Wallet already exists for walletId ${walletId}`)
    this.name = 'WalletAlreadyExistsError'
    this.walletId = walletId
  }
}

/**
 * Thrown by loadWallet when the walletId is not in the database.
 */
class WalletNotFoundError extends Error {
  /** ID that was requested but not found. */
  readonly walletId: string

  /**
   * Construct a WalletNotFoundError.
   * @param walletId - The wallet ID that could not be located.
   */
  constructor (walletId: string) {
    super(`No wallet found for walletId ${walletId}`)
    this.name = 'WalletNotFoundError'
    this.walletId = walletId
  }
}

export {
  InvalidMnemonicError,
  InvalidEncryptionKeyError,
  WalletAlreadyExistsError,
  WalletNotFoundError
}
