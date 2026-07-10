import { bytesToHex } from '@railgun-reloaded/bytes'
import type { DBNote, WalletStorage } from '@railgun-reloaded/storage'

import type { NetworkConfig as NetworkConfigEntry } from '../../network-config.js'
import { NETWORK_CONFIG } from '../../network-config.js'
import {
  classifyNoteSpendState,
  toWalletBalanceBucket
} from '../../poi/bucket-classifier.js'
import type { NoteSpendState } from '../../poi/types.js'
import { WalletBalanceBucket } from '../../poi/types.js'
import { WalletNotFoundError } from '../wallet/errors.js'

/**
 * Aggregated unspent balance for a single ERC-20 token.
 */
type TokenBalance = {
  token: string
  balance: bigint
}

type BalanceMode = 'spendable' | 'all' | WalletBalanceBucket

/**
 * A note owned by a wallet. Bytes columns are exposed as 0x-prefixed lowercase
 * hex; the leaf index is widened to bigint for uniformity with `blockNumber`
 * and `amount`. `tokenType` is the integer token-class enum
 * (0 = ERC20, 1 = ERC721); `tokenSubID` is the 32-byte
 * sub-identifier (zero hex for ERC20). `spendState` separates protocol
 * spendability from optional POI-service state.
 */
type DecryptedNote = {
  commitment: string
  nullifier: string
  token: string
  amount: bigint
  tokenType: number
  tokenSubID: string
  blockNumber: bigint
  treeNumber: number
  leafIndex: bigint
  spent: boolean
  spentTxid: string | null
  spendState: NoteSpendState
  decryptedAt: Date
}

/**
 * Map a stored note row to the public `DecryptedNote` type. Bytes columns
 * become 0x-prefixed lowercase hex; `treePosition` is widened to bigint and
 * exposed as `leafIndex`.
 * @param row - Row from `getAllNotes` / `getUnspentNotes`.
 * @param network - Optional resolved network config for the note chain.
 * @returns Public-facing DecryptedNote.
 */
function mapNoteRow (
  row: DBNote,
  network: NetworkConfigEntry = getNetworkConfigByChainId(row.chainId)
): DecryptedNote {
  const {
    commitment,
    nullifier,
    token,
    amount,
    tokenType,
    tokenSubID,
    blockNumber,
    treeNumber,
    treePosition,
    spent,
    spentTxid,
    decryptedAt
  } = row
  const publicSpentTxid = spentTxid === null
    ? null
    : bytesToHex(spentTxid, { prefix: true })
  return {
    commitment: bytesToHex(commitment, { prefix: true }),
    nullifier: bytesToHex(nullifier, { prefix: true }),
    token,
    amount,
    tokenType,
    tokenSubID: bytesToHex(tokenSubID, { prefix: true }),
    blockNumber,
    treeNumber,
    leafIndex: BigInt(treePosition),
    spent,
    spentTxid: publicSpentTxid,
    spendState: mapNoteSpendState(row, network),
    decryptedAt
  }
}

type BucketBalanceAccumulators = Record<WalletBalanceBucket, Map<string, bigint>>

/**
 * Create empty balance accumulators for every wallet bucket.
 * @returns Bucket accumulators keyed by wallet balance bucket.
 */
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

/**
 * Create the public empty bucket balance response.
 * @returns Empty token-balance arrays keyed by wallet balance bucket.
 */
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

/**
 * Resolve the network config for a chain ID.
 * @param chainId - Chain ID to resolve.
 * @returns Network config for the chain.
 */
function getNetworkConfigByChainId (chainId: number): NetworkConfigEntry {
  const network = Object.values(NETWORK_CONFIG)
    .find(network => network.chainID === chainId)
  if (network === undefined) {
    throw new Error(`Missing network config for chain ${chainId}`)
  }
  return network
}

/**
 * Build the protocol and optional POI tiers for a stored note.
 * @param note - Stored wallet note.
 * @param network - Network config for the note chain.
 * @returns Two-tier note spend state.
 */
function mapNoteSpendState (
  note: DBNote,
  network: NetworkConfigEntry
): NoteSpendState {
  return classifyNoteSpendState(note, network)
}

/**
 * Add a note amount to a token balance accumulator.
 * @param balances - Mutable token balance map.
 * @param note - Stored note whose amount should be added.
 */
function addNoteBalance (
  balances: Map<string, bigint>,
  note: DBNote
): void {
  balances.set(note.token, (balances.get(note.token) ?? 0n) + note.amount)
}

/**
 * Convert a token balance accumulator to the public array shape.
 * @param balances - Token balance accumulator.
 * @returns Positive token balances.
 */
function mapBalanceAccumulator (
  balances: Map<string, bigint>
): TokenBalance[] {
  return [...balances.entries()]
    .filter(([, balance]) => balance > 0n)
    .map(([token, balance]) => ({ token, balance }))
}

/**
 * Convert bucket accumulators to public bucket balances.
 * @param accumulators - Mutable bucket accumulators.
 * @returns Token balances keyed by wallet balance bucket.
 */
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
 * Read API over wallet storage: balances and notes for a single wallet. Pure
 * pass-through over storage helpers — does not own the DB and never closes
 * it. Throws `WalletNotFoundError` when the wallet ID is unknown.
 */
class BalanceService {
  /** Reference to the injected wallet storage contract. */
  readonly #storage: WalletStorage

  /**
   * Construct a BalanceService bound to a specific wallet storage contract.
   * @param storage - Pre-configured wallet storage contract.
   */
  constructor (storage: WalletStorage) {
    this.#storage = storage
  }

  /**
   * Throw `WalletNotFoundError` if no wallet with this ID exists.
   * @param walletId - Wallet ID to check.
   */
  async #assertWalletExists (walletId: string): Promise<void> {
    if (!(await this.#storage.getWallet(walletId))) {
      throw new WalletNotFoundError(walletId)
    }
  }

  /**
   * Read ERC-20 balances for a wallet on a given chain from live unspent notes.
   * The default mode returns notes classified as Spendable. On networks
   * without PPOI configured, every unspent note is Spendable.
   * @param walletId - Wallet ID returned by `createWallet`.
   * @param chainId - Chain id to scope the lookup to (e.g. 11155111 for Sepolia).
   * @param mode - Balance mode: default spendable, all unspent, or one bucket.
   * @returns Public token balances grouped by token.
   */
  async getBalances (
    walletId: string,
    chainId: number,
    mode: BalanceMode = 'spendable'
  ): Promise<TokenBalance[]> {
    await this.#assertWalletExists(walletId)
    const network = getNetworkConfigByChainId(chainId)
    const notes = await this.#storage.getUnspentNotes(walletId, chainId)
    if (notes.length === 0) {
      return []
    }

    const balances = new Map<string, bigint>()

    if (mode === 'all') {
      for (const note of notes) {
        addNoteBalance(balances, note)
      }
      return mapBalanceAccumulator(balances)
    }

    const targetBucket = mode === 'spendable'
      ? WalletBalanceBucket.Spendable
      : mode

    for (const note of notes) {
      const bucket = toWalletBalanceBucket(
        classifyNoteSpendState(note, network)
      )
      if (bucket === targetBucket) {
        addNoteBalance(balances, note)
      }
    }

    return mapBalanceAccumulator(balances)
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
    await this.#assertWalletExists(walletId)
    const network = getNetworkConfigByChainId(chainId)

    const notes = await this.#storage.getUnspentNotes(walletId, chainId)
    if (notes.length === 0) {
      return createEmptyBucketBalances()
    }

    const accumulators = createBucketAccumulators()
    for (const note of notes) {
      const bucket = toWalletBalanceBucket(
        classifyNoteSpendState(note, network)
      )
      addNoteBalance(accumulators[bucket], note)
    }

    return mapBucketAccumulators(accumulators)
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
    await this.#assertWalletExists(walletId)
    const rows = options.unspent === true
      ? await this.#storage.getUnspentNotes(walletId, chainId)
      : await this.#storage.getAllNotes(walletId, chainId)
    return rows.map((row) => mapNoteRow(row))
  }
}

export { BalanceService, mapNoteRow, mapNoteSpendState }
export type { BalanceMode, DecryptedNote, TokenBalance }
