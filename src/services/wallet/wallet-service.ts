import type { WalletDB } from '@railgun-reloaded/storage/node'
import {
  createWallet as dbCreateWallet,
  deleteWallet as dbDeleteWallet,
  getWallet as dbGetWallet,
  listWallets as dbListWallets
} from '@railgun-reloaded/storage/node'
import { Mnemonic } from '@railgun-reloaded/wallet-node'

import {
  InvalidEncryptionKeyError,
  InvalidMnemonicError,
  WalletAlreadyExistsError,
  WalletNotFoundError
} from './errors.js'
import { deriveWalletKeys } from './keys.js'
import { decryptWalletBlob, encryptWalletBlob } from './wallet-crypto.js'
import { generateWalletId } from './wallet-id.js'

/**
 * Arguments for WalletService.createWallet.
 */
type CreateWalletParams = {
  mnemonic: string
  encryptionKey: Uint8Array
  index?: number
  name?: string
}

/**
 * Public, decrypt-free metadata describing a stored wallet. Returned by
 * createWallet and listWallets — contains no key material.
 */
type WalletInfo = {
  walletId: string
  name: string | null
  createdAt: Date
}

/**
 * Full key material for a loaded wallet. Returned by loadWallet. Excludes
 * the spending key by design (kept encrypted at rest; re-derived on demand
 * by future signing APIs).
 */
type WalletContext = {
  walletId: string
  name: string | null
  railgunAddress: string
  masterPublicKey: Uint8Array
  viewingPublicKey: Uint8Array
  viewingPrivateKey: Uint8Array
  nullifyingKey: Uint8Array
}

/**
 * Per-wallet lifecycle operations. Owns the wallet DB plus the encryption
 * and key-derivation pipelines. Knows nothing about chains or scanning —
 * those belong to RailgunEngine.
 */
class WalletService {
  /** Reference to the injected wallet database. */
  readonly #db: WalletDB

  /**
   * Construct a WalletService bound to a specific wallet database.
   * @param db - Pre-configured WalletDB (from `createWalletDB`).
   */
  constructor (db: WalletDB) {
    this.#db = db
  }

  /**
   * Create and persist a new encrypted wallet.
   *
   * Returns decrypt-free metadata. The caller must call loadWallet with the
   * same encryption key to get usable key material — create never returns
   * keys.
   * @param params - Mnemonic + encryption key + optional index/name.
   * @returns Decrypt-free WalletInfo.
   * @throws InvalidMnemonicError — BIP39 validation failed.
   * @throws InvalidEncryptionKeyError — encryption key isn't 32 bytes.
   * @throws WalletAlreadyExistsError — (mnemonic, index) collision; the
   *   error's `.walletId` holds the existing wallet's ID.
   */
  async createWallet (params: CreateWalletParams): Promise<WalletInfo> {
    const { mnemonic, encryptionKey, index = 0, name } = params

    if (!Mnemonic.validate(mnemonic)) {
      throw new InvalidMnemonicError()
    }
    if (encryptionKey.length !== 32) {
      throw new InvalidEncryptionKeyError(
        `encryptionKey must be 32 bytes, received ${encryptionKey.length}`
      )
    }

    const walletId = generateWalletId(mnemonic, index)
    const encryptedKeys = encryptWalletBlob({ mnemonic, index }, encryptionKey)
    const createdAt = new Date()

    try {
      await dbCreateWallet(this.#db, {
        id: walletId,
        encryptedKeys,
        name: name ?? null,
        createdAt
      })
    } catch (err: unknown) {
      if (isPrimaryKeyConflict(err)) {
        throw new WalletAlreadyExistsError(walletId)
      }
      throw err
    }

    return { walletId, name: name ?? null, createdAt }
  }

  /**
   * Load a wallet by ID and return its decrypted key material.
   * @param walletId - Deterministic wallet ID to look up.
   * @param encryptionKey - The same 32-byte key used at createWallet time.
   * @returns Full WalletContext (minus spending key).
   * @throws WalletNotFoundError — no row for `walletId`.
   * @throws InvalidEncryptionKeyError — wrong length, GCM auth failed, or
   *   decrypted blob is malformed.
   */
  async loadWallet (walletId: string, encryptionKey: Uint8Array): Promise<WalletContext> {
    const row = await dbGetWallet(this.#db, walletId)
    if (!row) {
      throw new WalletNotFoundError(walletId)
    }

    const blob = decryptWalletBlob(row.encryptedKeys, encryptionKey)
    const {
      railgunAddress,
      masterPublicKey,
      viewingPublicKey,
      viewingPrivateKey,
      nullifyingKey
    } = await deriveWalletKeys(blob.mnemonic, blob.index)

    return {
      walletId: row.id,
      name: row.name ?? null,
      railgunAddress,
      masterPublicKey,
      viewingPublicKey,
      viewingPrivateKey,
      nullifyingKey
    }
  }

  /**
   * List all stored wallets, sorted ascending by creation time.
   *
   * Does not require an encryption key — returned metadata contains no
   * secret material.
   * @returns Array of WalletInfo records.
   */
  async listWallets (): Promise<WalletInfo[]> {
    const rows = await dbListWallets(this.#db)
    const sorted = [...rows].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    )
    return sorted.map(row => ({
      walletId: row.id,
      name: row.name ?? null,
      createdAt: row.createdAt
    }))
  }

  /**
   * Delete a wallet by ID. Unknown IDs are no-ops (idempotent).
   * @param walletId - Wallet ID to remove.
   */
  async deleteWallet (walletId: string): Promise<void> {
    await dbDeleteWallet(this.#db, walletId)
  }
}

/**
 * Narrow check for a better-sqlite3 PRIMARY KEY constraint violation.
 * @param err - Thrown value from a SQLite operation.
 * @returns True when the error represents a PK collision specifically.
 */
function isPrimaryKeyConflict (err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  )
}

export { WalletService }
export type { CreateWalletParams, WalletInfo, WalletContext }
