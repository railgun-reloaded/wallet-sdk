import { bytesToHex } from '@railgun-reloaded/bytes'
import type { DBBalance, DBNote, WalletDB } from '@railgun-reloaded/storage'
import {
  getAllBalances,
  getAllNotes,
  getBalance,
  getUnspentNotes,
  getWallet
} from '@railgun-reloaded/storage'

import { NETWORK_CONFIG } from '../../network-config'
import type { NetworkConfig as NetworkConfigEntry } from '../../network-config'
import { classifyNote } from '../../poi/bucket-classifier'
import { WalletBalanceBucket } from '../../poi/types'
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
 * Map a stored balance row to the public `TokenBalance` type.
 * @param row - Row from `getAllBalances`.
 * @returns Public-facing TokenBalance.
 */
function mapBalanceRow (row: DBBalance): TokenBalance {
  return {
    token: row.token,
    balance: row.amount
  }
}

/**
 * Map a stored note row to the public `DecryptedNote` type. Bytes columns
 * become 0x-prefixed lowercase hex; `treePosition` is widened to bigint and
 * exposed as `leafIndex`.
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
    commitment: bytesToHex(commitment, { prefix: true }),
    nullifier: bytesToHex(nullifier, { prefix: true }),
    token,
    amount,
    blockNumber,
    treeNumber,
    leafIndex: BigInt(treePosition),
    spent,
    spentTxid: spentTxid === null
      ? null
      : bytesToHex(spentTxid, { prefix: true }),
    decryptedAt
  }
}

type BucketBalanceAccumulators = Record<WalletBalanceBucket, Map<string, bigint>>

const NON_PPOI_NETWORK: NetworkConfigEntry = {
  chainID: 0,
  deploymentBlock: 0n,
  proxyContractAddress: '',
  rpcURL: ''
}

function createBucketAccumulators (): BucketBalanceAccumulators {
  return {
    [WalletBalanceBucket.Spendable]: new Map(),
    [WalletBalanceBucket.ShieldPending]: new Map(),
    [WalletBalanceBucket.ShieldBlocked]: new Map(),
    [WalletBalanceBucket.ProofSubmitted]: new Map(),
    [WalletBalanceBucket.MissingInternalPOI]: new Map(),
    [WalletBalanceBucket.MissingExternalPOI]: new Map(),
    [WalletBalanceBucket.Spent]: new Map()
  }
}

function createEmptyBucketBalances (): Record<WalletBalanceBucket, TokenBalance[]> {
  return {
    [WalletBalanceBucket.Spendable]: [],
    [WalletBalanceBucket.ShieldPending]: [],
    [WalletBalanceBucket.ShieldBlocked]: [],
    [WalletBalanceBucket.ProofSubmitted]: [],
    [WalletBalanceBucket.MissingInternalPOI]: [],
    [WalletBalanceBucket.MissingExternalPOI]: [],
    [WalletBalanceBucket.Spent]: []
  }
}

function getNetworkConfigByChainId (chainId: number): NetworkConfigEntry {
  return Object.values(NETWORK_CONFIG)
    .find(network => network.chainID === chainId) ?? NON_PPOI_NETWORK
}

function addNoteBalance (
  balances: Map<string, bigint>,
  note: DBNote
): void {
  balances.set(note.token, (balances.get(note.token) ?? 0n) + note.amount)
}

function mapBalanceAccumulator (
  balances: Map<string, bigint>
): TokenBalance[] {
  return [...balances.entries()]
    .filter(([, balance]) => balance > 0n)
    .map(([token, balance]) => ({ token, balance }))
}

function mapBucketAccumulators (
  accumulators: BucketBalanceAccumulators
): Record<WalletBalanceBucket, TokenBalance[]> {
  return {
    [WalletBalanceBucket.Spendable]: mapBalanceAccumulator(
      accumulators[WalletBalanceBucket.Spendable]
    ),
    [WalletBalanceBucket.ShieldPending]: mapBalanceAccumulator(
      accumulators[WalletBalanceBucket.ShieldPending]
    ),
    [WalletBalanceBucket.ShieldBlocked]: mapBalanceAccumulator(
      accumulators[WalletBalanceBucket.ShieldBlocked]
    ),
    [WalletBalanceBucket.ProofSubmitted]: mapBalanceAccumulator(
      accumulators[WalletBalanceBucket.ProofSubmitted]
    ),
    [WalletBalanceBucket.MissingInternalPOI]: mapBalanceAccumulator(
      accumulators[WalletBalanceBucket.MissingInternalPOI]
    ),
    [WalletBalanceBucket.MissingExternalPOI]: mapBalanceAccumulator(
      accumulators[WalletBalanceBucket.MissingExternalPOI]
    ),
    [WalletBalanceBucket.Spent]: mapBalanceAccumulator(
      accumulators[WalletBalanceBucket.Spent]
    )
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
   * Read all cached ERC-20 balances for a wallet on a given chain.
   * @param walletId - Wallet ID returned by `createWallet`.
   * @param chainId - Chain id to scope the lookup to (e.g. 11155111 for Sepolia).
   * @returns Public token balances from wallet.db.balances.
   */
  async getBalances (walletId: string, chainId: number): Promise<TokenBalance[]> {
    this.#assertWalletExists(walletId)
    return getAllBalances(this.#db, walletId, chainId)
      .filter(row => row.amount > 0n)
      .map(mapBalanceRow)
  }

  /**
   * Read spendable ERC-20 balances for a wallet on a given chain.
   * @param walletId - Wallet ID returned by `createWallet`.
   * @param chainId - Chain id to scope the lookup to.
   * @returns Token balances classified into `WalletBalanceBucket.Spendable`.
   */
  async getSpendableBalances (
    walletId: string,
    chainId: number
  ): Promise<TokenBalance[]> {
    return (await this.getBalancesByBucket(walletId, chainId))[WalletBalanceBucket.Spendable]
  }

  /**
   * Read unspent ERC-20 balances grouped by POI balance bucket.
   * @param walletId - Wallet ID returned by `createWallet`.
   * @param chainId - Chain id to scope the lookup to.
   * @returns Token balances keyed by `WalletBalanceBucket`.
   */
  async getBalancesByBucket (
    walletId: string,
    chainId: number
  ): Promise<Record<WalletBalanceBucket, TokenBalance[]>> {
    this.#assertWalletExists(walletId)

    const notes = getUnspentNotes(this.#db, walletId, chainId)
    if (notes.length === 0) {
      return createEmptyBucketBalances()
    }

    const network = getNetworkConfigByChainId(chainId)
    const accumulators = createBucketAccumulators()
    for (const note of notes) {
      addNoteBalance(accumulators[classifyNote(note, network)], note)
    }

    return mapBucketAccumulators(accumulators)
  }

  /**
   * Read one cached ERC-20 balance for a wallet on a given chain.
   * @param walletId - Wallet ID returned by `createWallet`.
   * @param chainId - Chain id to scope the lookup to.
   * @param tokenAddress - ERC-20 token address. Lookup is case-insensitive.
   * @returns Balance amount, or 0n when no cached balance exists.
   */
  async getTokenBalance (
    walletId: string,
    chainId: number,
    tokenAddress: string
  ): Promise<bigint> {
    this.#assertWalletExists(walletId)
    return getBalance(this.#db, walletId, chainId, tokenAddress)?.amount ?? 0n
  }

  /**
   * Read decrypted notes for a wallet on a given chain.
   * @param walletId - Wallet ID returned by `createWallet`.
   * @param chainId - Chain id to scope the lookup to.
   * @param options - Optional note filtering.
   * @param options.unspent - When true, return only notes with `spent === false`.
   * @returns Public decrypted-note records.
   */
  async getNotes (
    walletId: string,
    chainId: number,
    options: { unspent?: boolean } = {}
  ): Promise<DecryptedNote[]> {
    this.#assertWalletExists(walletId)
    const rows = options.unspent === true
      ? getUnspentNotes(this.#db, walletId, chainId)
      : getAllNotes(this.#db, walletId, chainId)
    return rows.map(mapNoteRow)
  }
}

export { BalanceService, mapBalanceRow, mapNoteRow }
export type { DecryptedNote, TokenBalance }
