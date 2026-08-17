import { bytesToHex, hexToBytes, padBytesLeft } from '@railgun-reloaded/bytes'
import type {
  ChainStorage,
  DBNote,
  DBRailgunTransaction,
  DBTxHistory,
  DBUnshield,
  WalletStorage
} from '@railgun-reloaded/storage'
import { OutputType, TokenType } from '@railgun-reloaded/wallet-node'

import { UnsupportedTokenTypeError } from '../contracts/errors.js'
import type { NetworkConfig as NetworkConfigEntry } from '../network-config.js'
import { classifyNoteSpendState } from '../poi/bucket-classifier.js'
import type { NoteSpendState } from '../poi/types.js'
import { CommitmentType } from '../sync/event-processor.js'
import { blockTimestampToDate } from '../sync/wallet-decryptor.js'

import type {
  HistoryTokenAmount,
  ReceivedKind,
  ReceivedTokenAmount,
  TransactionCategory,
  TransactionHistoryEntry,
  UnshieldTokenAmount
} from './types.js'

/** Byte width of a token sub-ID on chain. */
const TOKEN_SUB_ID_BYTES = 32

/** Sub-ID carried by every ERC20 amount: 32 zero bytes. */
const ERC20_TOKEN_SUB_ID = bytesToHex(new Uint8Array(TOKEN_SUB_ID_BYTES), {
  prefix: true
})

/**
 * Widen a token sub-ID to the width the chain uses.
 *
 * A data source records the sub-ID at whatever width it stores, so the same
 * ERC-20 arrives as one zero byte from one source and as 32 from another.
 * Consumers key amounts by this value, so both forms are widened to the
 * on-chain width and one token reads as one token.
 * @param value - Sub-ID as bytes, or as a hex string.
 * @returns Sub-ID as 32-byte lowercase hex, 0x-prefixed.
 * @throws {BytesError} When the sub-ID is not hex, or is wider than 32 bytes.
 */
function toCanonicalTokenSubID (value: Uint8Array | string): string {
  const bytes = typeof value === 'string'
    ? hexToBytes(value, { allowOddLength: true })
    : value
  return bytesToHex(
    padBytesLeft(bytes, TOKEN_SUB_ID_BYTES, { strict: true }),
    { prefix: true }
  )
}

/** Mutable accumulator for one transaction while the history is assembled. */
type EntryDraft = {
  txid: string
  blockNumber: bigint
  timestamp: Date | null
  received: ReceivedTokenAmount[]
  spent: HistoryTokenAmount[]
  unshields: UnshieldTokenAmount[]
  spendStates: NoteSpendState[]
}

/**
 * Decide why a note arrived in the wallet.
 *
 * A shield is known from the commitment type. Everything else is a transact
 * output, and its annotation only decrypts for outputs this wallet created,
 * so a note from another sender falls through to `transfer`.
 * @param note - Stored note row.
 * @returns The kind to report for the note.
 */
function receivedKind (note: DBNote): ReceivedKind {
  if (note.commitmentType === CommitmentType.Shield) {
    return 'shield'
  }
  return note.outputType === OutputType.Change ? 'change' : 'transfer'
}

/**
 * Rank a note's PPOI state by how settled it is, cleared lowest.
 * @param state - PPOI state of one note.
 * @returns Rank used to pick the least settled state of a set.
 */
function settlementRank (state: NoteSpendState): number {
  if (state.poi === null || state.poi.kind === 'cleared') {
    return 0
  }
  return state.poi.kind === 'pending' ? 1 : 2
}

/**
 * Reduce a transaction's note states to the least settled one, so an entry
 * only reads as cleared when every note it created is.
 * @param states - PPOI states of the notes the transaction created.
 * @returns The least settled state, or null when there were no notes.
 */
function leastSettled (states: NoteSpendState[]): NoteSpendState | null {
  let worst: NoteSpendState | null = null
  for (const state of states) {
    if (worst === null || settlementRank(state) > settlementRank(worst)) {
      worst = state
    }
  }
  return worst
}

/**
 * Decide what a transaction did for this wallet.
 *
 * Order matters: a transaction that unshields also spends, and a send also
 * receives its own change, so the most specific outcome is tested first.
 * @param draft - Accumulated amounts for one transaction.
 * @returns The category to report.
 */
function categorize (draft: EntryDraft): TransactionCategory {
  if (draft.unshields.length > 0) {
    return 'unshield'
  }
  if (draft.spent.length > 0) {
    return 'send'
  }
  return draft.received.every((amount) => amount.kind === 'shield')
    ? 'shield'
    : 'receive'
}

/**
 * Key an amount by the token it moves, so amounts of different tokens in one
 * transaction never total together.
 * @param amount - Amount to key.
 * @returns Key identifying the token.
 */
function tokenKey (amount: HistoryTokenAmount): string {
  return `${amount.token}:${amount.tokenType}:${amount.tokenSubID}`
}

/**
 * Take an amount off a token's running total, when that token has one.
 * @param totals - Running totals keyed by token.
 * @param amount - Amount naming the token to deduct from.
 * @param value - Value to deduct.
 */
function deduct (
  totals: Map<string, HistoryTokenAmount>,
  amount: HistoryTokenAmount,
  value: bigint
): void {
  const running = totals.get(tokenKey(amount))
  if (running !== undefined) {
    running.amount -= value
  }
}

/**
 * Total, per token, the notes a transaction spent less the change it returned
 * and the value it unshielded.
 * @param draft - Accumulated amounts for one transaction.
 * @returns One amount per token, omitting tokens with nothing left over.
 */
function transferredAmounts (draft: EntryDraft): HistoryTokenAmount[] {
  const totals = new Map<string, HistoryTokenAmount>()
  for (const amount of draft.spent) {
    const key = tokenKey(amount)
    const running = totals.get(key)
    if (running === undefined) {
      totals.set(key, { ...amount })
      continue
    }
    running.amount += amount.amount
  }

  for (const amount of draft.received) {
    if (amount.kind === 'change') {
      deduct(totals, amount, amount.amount)
    }
  }
  for (const unshield of draft.unshields) {
    // The event records the recipient's amount net of the fee; the notes
    // spent covered both.
    deduct(totals, unshield, unshield.amount + unshield.fee)
  }

  return [...totals.values()].filter((amount) => amount.amount > 0n)
}

/**
 * Find or start the accumulator for a transaction.
 * @param drafts - Accumulators so far, keyed by transaction hash.
 * @param txid - Transaction hash the amount belongs to.
 * @param blockNumber - Block the transaction was mined in.
 * @returns The accumulator for that transaction.
 */
function draftFor (
  drafts: Map<string, EntryDraft>,
  txid: string,
  blockNumber: bigint
): EntryDraft {
  const existing = drafts.get(txid)
  if (existing !== undefined) {
    return existing
  }
  const draft: EntryDraft = {
    txid,
    blockNumber,
    timestamp: null,
    received: [],
    spent: [],
    unshields: [],
    spendStates: []
  }
  drafts.set(txid, draft)
  return draft
}

/**
 * Describe the token a note or unshield moved.
 * @param token - Token contract address.
 * @param tokenType - Token standard the amount belongs to.
 * @param tokenSubID - Token sub-ID bytes.
 * @param amount - Amount in base units.
 * @returns Token amount in public form.
 */
function toTokenAmount (
  token: string,
  tokenType: TokenType,
  tokenSubID: Uint8Array,
  amount: bigint
): HistoryTokenAmount {
  return {
    token,
    tokenType,
    tokenSubID: toCanonicalTokenSubID(tokenSubID),
    amount
  }
}

/**
 * Read a token standard from a stored value.
 *
 * A data source records the standard either as the on-chain number or by
 * name. Both forms resolve to the same value.
 * @param value - Stored token type, in numeric or named form.
 * @returns The token standard.
 * @throws UnsupportedTokenTypeError when the value names no supported standard.
 */
function toTokenType (value: number | string): TokenType {
  switch (String(value).toUpperCase()) {
    case '0':
    case 'ERC20':
      return TokenType.ERC20
    case '1':
    case 'ERC721':
      return TokenType.ERC721
    default:
      throw new UnsupportedTokenTypeError(value)
  }
}

/**
 * Key a hash the way the maps below are keyed.
 * @param value - Hash or address bytes.
 * @returns Lowercase 0x-prefixed hex.
 */
function hashKey (value: Uint8Array): string {
  return bytesToHex(value, { prefix: true }).toLowerCase()
}

/**
 * Group rows by the transaction hash they carry.
 * @param rows - Rows to group.
 * @param txidOf - Reads the transaction hash off a row.
 * @returns Rows keyed by 0x-prefixed transaction hash.
 */
function groupByTxid<Row> (
  rows: Row[],
  txidOf: (row: Row) => Uint8Array
): Map<string, Row[]> {
  const byTxid = new Map<string, Row[]>()
  for (const row of rows) {
    const txid = hashKey(txidOf(row))
    const existing = byTxid.get(txid)
    if (existing === undefined) {
      byTxid.set(txid, [row])
      continue
    }
    existing.push(row)
  }
  return byTxid
}

/**
 * Decide whether a Railgun transaction spent any of this wallet's notes.
 * @param transaction - Stored Railgun transaction.
 * @param spentNullifiers - Nullifiers of the notes this wallet spent.
 * @returns True when the transaction spent a note this wallet held.
 */
function spendsWalletNote (
  transaction: DBRailgunTransaction,
  spentNullifiers: Set<string>
): boolean {
  const nullifiers = transaction.nullifiers as Uint8Array[] | null | undefined
  if (nullifiers === null || nullifiers === undefined) {
    return false
  }
  return nullifiers.some((nullifier) => spentNullifiers.has(hashKey(nullifier)))
}

/**
 * Pick the unshield events of one transaction that belong to this wallet.
 *
 * One transaction can carry the Railgun transactions of several wallets, so
 * its hash alone does not say whose unshield an event is. A wallet's spent
 * nullifiers name its own Railgun transactions, and each of those names the
 * address it unshielded to, which identifies the event.
 *
 * A transaction whose Railgun transactions were not recorded carries no such
 * evidence, and its events are reported as they are.
 * @param events - Unshield events of one transaction.
 * @param transactions - Railgun transactions recorded for that transaction.
 * @param spentNullifiers - Nullifiers of the notes this wallet spent.
 * @returns The events this wallet unshielded.
 */
function ownUnshieldEvents (
  events: DBUnshield[],
  transactions: DBRailgunTransaction[] | undefined,
  spentNullifiers: Set<string>
): DBUnshield[] {
  if (transactions === undefined || transactions.length === 0) {
    return events
  }

  const recipients = new Set<string>()
  for (const transaction of transactions) {
    if (!transaction.hasUnshield) continue
    if (!spendsWalletNote(transaction, spentNullifiers)) continue
    const unshield = transaction.unshield as { to?: Uint8Array } | null | undefined
    if (unshield?.to === undefined) continue
    recipients.add(hashKey(unshield.to))
  }

  if (recipients.size === 0) {
    return []
  }
  return events.filter((event) => recipients.has(hashKey(event.toAddress)))
}

/**
 * Read the unshield events this wallet produced in the blocks it spent in.
 *
 * Unshields are queried a block at a time rather than across one wide range,
 * because a wallet's spends are few and far apart and the table holds every
 * unshield on the chain.
 * @param chainStorage - Chain storage holding unshield events.
 * @param blocks - Blocks the wallet spent notes in.
 * @param spentNullifiers - Nullifiers of the notes this wallet spent.
 * @returns Unshield events keyed by 0x-prefixed transaction hash.
 */
async function readUnshieldsByTxid (
  chainStorage: ChainStorage,
  blocks: Set<bigint>,
  spentNullifiers: Set<string>
): Promise<Map<string, DBUnshield[]>> {
  const byTxid = new Map<string, DBUnshield[]>()
  for (const block of blocks) {
    const events = await chainStorage.getUnshieldsByBlockRange(block, block)
    if (events.length === 0) {
      continue
    }
    const transactions = await chainStorage.getRailgunTransactionsByBlockRange(
      block,
      block
    )
    const transactionsByTxid = groupByTxid(
      transactions,
      (transaction) => transaction.chainTxid
    )

    for (const [txid, txEvents] of groupByTxid(
      events,
      (event) => event.transactionHash
    )) {
      const own = ownUnshieldEvents(
        txEvents,
        transactionsByTxid.get(txid),
        spentNullifiers
      )
      if (own.length === 0) {
        continue
      }
      const existing = byTxid.get(txid)
      if (existing === undefined) {
        byTxid.set(txid, own)
        continue
      }
      existing.push(...own)
    }
  }
  return byTxid
}

/**
 * Describe an unshield event, naming the token it moved.
 *
 * The event's own token is used when the chain data carries it. Databases
 * scanned before unshield tokens were persisted fall back to the token of
 * a note the transaction spent, which is the same token whenever a
 * transaction moves one. A token is always named either way, so no amount
 * reports an address that names no contract.
 * @param event - Stored unshield event.
 * @param fallback - Token of a note the transaction spent from this wallet.
 * @returns The unshielded amount in public form.
 */
function toUnshieldAmount (
  event: DBUnshield,
  fallback: HistoryTokenAmount
): UnshieldTokenAmount {
  const eventToken = event.token as
    | {
      tokenAddress?: Uint8Array
      tokenSubID?: Uint8Array
      tokenType?: number | string
    }
    | null
    | undefined
  const token = eventToken?.tokenAddress !== undefined
    ? bytesToHex(eventToken.tokenAddress, { prefix: true }).toLowerCase()
    : fallback.token
  const tokenSubID = eventToken?.tokenSubID !== undefined
    ? toCanonicalTokenSubID(eventToken.tokenSubID)
    : fallback.tokenSubID
  const tokenType = eventToken?.tokenType !== undefined
    ? toTokenType(eventToken.tokenType)
    : fallback.tokenType

  return {
    token,
    tokenType,
    tokenSubID,
    amount: event.amount,
    fee: event.fee,
    toAddress: bytesToHex(event.toAddress, { prefix: true })
  }
}

/**
 * Turn a recorded transaction row into a pending entry.
 *
 * These rows exist from the moment a transaction confirms, so the history
 * covers what the wallet did before the data source has indexed the block.
 * A row that names no token reports the transaction with no amounts, rather
 * than an amount whose address names no contract.
 * @param row - Stored transaction-history row.
 * @returns Entry marked as awaiting decryption.
 */
function toPendingEntry (row: DBTxHistory): TransactionHistoryEntry {
  const metadata = (row.metadata ?? {}) as {
    token?: string
    tokenType?: number | string
    tokenSubID?: string
    amount?: string
  }
  const amounts: HistoryTokenAmount[] = metadata.token === undefined
    ? []
    : [{
        token: metadata.token,
        tokenType: metadata.tokenType === undefined
          ? TokenType.ERC20
          : toTokenType(metadata.tokenType),
        tokenSubID: metadata.tokenSubID === undefined
          ? ERC20_TOKEN_SUB_ID
          : toCanonicalTokenSubID(metadata.tokenSubID),
        amount: metadata.amount === undefined ? 0n : BigInt(metadata.amount)
      }]

  return {
    txid: row.txid,
    blockNumber: row.blockNumber,
    timestamp: row.timestamp,
    category: row.type === 'unshield' ? 'unshield' : row.type === 'transfer' ? 'send' : 'shield',
    received: row.type === 'shield'
      ? amounts.map((amount) => ({ ...amount, kind: 'shield' as const }))
      : [],
    spent: row.type === 'shield' ? [] : amounts,
    transferred: row.type === 'transfer' ? amounts : [],
    unshields: row.type === 'unshield'
      ? amounts.map((amount) => ({ ...amount, fee: 0n, toAddress: '' }))
      : [],
    spendState: null,
    pending: true
  }
}

/**
 * Build this wallet's transaction history from its decrypted notes.
 *
 * Notes are grouped twice — by the transaction that created them and by the
 * transaction that spent them — and the two groupings are merged per
 * transaction, so one entry describes everything a transaction did for the
 * wallet. Recorded transactions that decryption has not reached yet are
 * folded in as pending entries.
 * @param params - Storage handles, wallet and chain to read, and row limit.
 * @param params.walletStorage - Wallet storage holding decrypted notes.
 * @param params.chainStorage - Chain storage holding unshield events, when open.
 * @param params.walletId - Wallet whose history should be built.
 * @param params.chainId - Chain to scope the history to.
 * @param params.network - Network config for the chain, used for PPOI state.
 * @param params.limit - Optional maximum number of entries to return.
 * @returns Entries newest first.
 */
async function buildTransactionHistory (params: {
  walletStorage: WalletStorage
  chainStorage: ChainStorage | undefined
  walletId: string
  chainId: number
  network: NetworkConfigEntry
  limit?: number | undefined
}): Promise<TransactionHistoryEntry[]> {
  const notes = await params.walletStorage.getAllNotes(
    params.walletId,
    params.chainId
  )
  const drafts = new Map<string, EntryDraft>()
  const spentBlocks = new Set<bigint>()
  const spentNullifiers = new Set<string>()

  for (const note of notes) {
    // A zero-value note pads a circuit rather than moving value.
    if (note.amount === 0n) {
      continue
    }
    const amount = toTokenAmount(
      note.token,
      toTokenType(note.tokenType),
      note.tokenSubID,
      note.amount
    )

    if (note.creationTxid !== null) {
      const draft = draftFor(
        drafts,
        bytesToHex(note.creationTxid, { prefix: true }),
        note.blockNumber
      )
      draft.received.push({ ...amount, kind: receivedKind(note) })
      draft.spendStates.push(classifyNoteSpendState(note, params.network))
    }

    if (note.spentTxid !== null) {
      const draft = draftFor(
        drafts,
        bytesToHex(note.spentTxid, { prefix: true }),
        note.spentBlockNumber ?? note.blockNumber
      )
      draft.spent.push(amount)
      spentNullifiers.add(hashKey(note.nullifier))
      if (note.spentTimestamp !== null) {
        draft.timestamp = note.spentTimestamp
      }
      if (note.spentBlockNumber !== null) {
        draft.blockNumber = note.spentBlockNumber
        spentBlocks.add(note.spentBlockNumber)
      }
    }
  }

  if (params.chainStorage !== undefined && spentBlocks.size > 0) {
    const unshieldsByTxid = await readUnshieldsByTxid(
      params.chainStorage,
      spentBlocks,
      spentNullifiers
    )
    for (const draft of drafts.values()) {
      const events = unshieldsByTxid.get(draft.txid)
      if (events === undefined) continue
      // An unshield spends a note, so a transaction this wallet spent nothing
      // in did not unshield for it.
      const fallback = draft.spent[0]
      if (fallback === undefined) continue
      for (const event of events) {
        draft.unshields.push(toUnshieldAmount(event, fallback))
        draft.timestamp = blockTimestampToDate(event.timestamp)
      }
    }
  }

  const entries: TransactionHistoryEntry[] = [...drafts.values()].map(
    (draft) => ({
      txid: draft.txid,
      blockNumber: draft.blockNumber,
      timestamp: draft.timestamp,
      category: categorize(draft),
      received: draft.received,
      spent: draft.spent,
      transferred: transferredAmounts(draft),
      unshields: draft.unshields,
      spendState: leastSettled(draft.spendStates),
      pending: false
    })
  )

  const derived = new Set(entries.map((entry) => entry.txid.toLowerCase()))
  // Every recorded row is read, not just as many as the caller asked for,
  // because the merge below drops the ones decryption already covers.
  const recorded = await params.walletStorage.getTxHistory(
    params.walletId,
    params.chainId
  )
  for (const row of recorded) {
    if (derived.has(row.txid.toLowerCase())) continue
    entries.push(toPendingEntry(row))
  }

  entries.sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0))
  return params.limit === undefined ? entries : entries.slice(0, params.limit)
}

export { buildTransactionHistory }
