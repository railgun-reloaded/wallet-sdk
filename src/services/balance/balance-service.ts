import type { DBBalance, DBNote, WalletDB } from '@railgun-reloaded/storage'
import {
  getAllBalances,
  getAllNotes,
  getBalance,
  getUnspentNotes,
  getWallet
} from '@railgun-reloaded/storage'
import { uint8ArrayToHex } from '@railgun-reloaded/wallet-node'

import { WalletNotFoundError } from '../wallet/errors'

/**
 * Aggregated unspent balance for a single ERC-20 token.
 */
type TokenBalance = {
  token: string
  balance: bigint
}

/**
 * A note owned by a wallet. Bytes columns are exposed as 0x-prefixed lowercase
 * hex; the leaf index is widened to bigint for uniformity with `blockNumber`
 * and `amount`.
 */
type DecryptedNote = {
  commitment: string
  nullifier: string
  token: string
  amount: bigint
  blockNumber: bigint
  treeNumber: number
  leafIndex: bigint
  spent: boolean
  spentTxid: string | null
  decryptedAt: Date
}

/**
 * Map a stored balance row to the public `TokenBalance` type. Lowercases the
 * token address so the public surface is case-stable regardless of how the
 * write path stored it.
 * @param row - Row from `getAllBalances`.
 * @returns Public-facing TokenBalance.
 */
function mapBalanceRow (row: DBBalance): TokenBalance {
  return {
    token: row.token.toLowerCase(),
    balance: row.amount
  }
}

/**
 * Map a stored note row to the public `DecryptedNote` type. Bytes columns
 * become 0x-prefixed lowercase hex; `treePosition` is widened to bigint and
 * exposed as `leafIndex`; `token` is lowercased.
 * @param row - Row from `getAllNotes` / `getUnspentNotes`.
 * @returns Public-facing DecryptedNote.
 */
function mapNoteRow (row: DBNote): DecryptedNote {
  const {
    commitment,
    nullifier,
    token,
    amount,
    blockNumber,
    treeNumber,
    treePosition,
    spent,
    spentTxid,
    decryptedAt
  } = row
  return {
    commitment: uint8ArrayToHex(commitment),
    nullifier: uint8ArrayToHex(nullifier),
    token: token.toLowerCase(),
    amount,
    blockNumber,
    treeNumber,
    leafIndex: BigInt(treePosition),
    spent,
    spentTxid: spentTxid === null
      ? null
      : uint8ArrayToHex(spentTxid),
    decryptedAt
  }
}

/**
 * Read API over a wallet DB: balances and notes for a single wallet. Pure
 * pass-through over storage helpers — does not own the DB and never closes
 * it. Throws `WalletNotFoundError` when the wallet ID is unknown.
 */
class BalanceService {
  /** Reference to the injected wallet database. */
  readonly #db: WalletDB

  /**
   * Construct a BalanceService bound to a specific wallet DB.
   * @param db - Pre-configured WalletDB (from `createWalletDB`).
   */
  constructor (db: WalletDB) {
    this.#db = db
  }

  /**
   * Throw `WalletNotFoundError` if no wallet with this ID exists.
   * @param walletId - Wallet ID to check.
   */
  #assertWalletExists (walletId: string): void {
    if (!getWallet(this.#db, walletId)) {
      throw new WalletNotFoundError(walletId)
    }
  }

  /**
   * Read all cached ERC-20 balances for a wallet.
   * @param walletId - Wallet ID returned by `createWallet`.
   * @returns Public token balances from wallet.db.balances.
   */
  async getBalances (walletId: string): Promise<TokenBalance[]> {
    this.#assertWalletExists(walletId)
    return getAllBalances(this.#db, walletId)
      .filter(row => row.amount > 0n)
      .map(mapBalanceRow)
  }

  /**
   * Read one cached ERC-20 balance for a wallet.
   * @param walletId - Wallet ID returned by `createWallet`.
   * @param tokenAddress - ERC-20 token address. Lookup is case-insensitive.
   * @returns Balance amount, or 0n when no cached balance exists.
   */
  async getTokenBalance (
    walletId: string,
    tokenAddress: string
  ): Promise<bigint> {
    this.#assertWalletExists(walletId)
    return getBalance(this.#db, walletId, tokenAddress.toLowerCase())?.amount ?? 0n
  }

  /**
   * Read decrypted notes for a wallet.
   * @param walletId - Wallet ID returned by `createWallet`.
   * @param options - Optional note filtering.
   * @param options.unspent - When true, return only notes with `spent === false`.
   * @returns Public decrypted-note records.
   */
  async getNotes (
    walletId: string,
    options: { unspent?: boolean } = {}
  ): Promise<DecryptedNote[]> {
    this.#assertWalletExists(walletId)
    const rows = options.unspent === true
      ? getUnspentNotes(this.#db, walletId)
      : getAllNotes(this.#db, walletId)
    return rows.map(mapNoteRow)
  }
}

export { BalanceService, mapBalanceRow, mapNoteRow }
export type { DecryptedNote, TokenBalance }
