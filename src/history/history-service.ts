import { bytesToHex } from '@railgun-reloaded/bytes'
import type {
  ChainStorage,
  DBNote,
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

/** Sub-ID carried by every ERC20 amount: 32 zero bytes. */
const ERC20_TOKEN_SUB_ID = bytesToHex(new Uint8Array(32), { prefix: true })

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
    tokenSubID: bytesToHex(tokenSubID, { prefix: true }),
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
 * Read the unshield events for the blocks a wallet spent notes in.
 *
 * Unshields are queried a block at a time rather than across one wide range,
 * because a wallet's spends are few and far apart and the table holds every
 * unshield on the chain.
 * @param chainStorage - Chain storage holding unshield events.
 * @param blocks - Blocks the wallet spent notes in.
 * @returns Unshield events keyed by 0x-prefixed transaction hash.
 */
async function readUnshieldsByTxid (
  chainStorage: ChainStorage,
  blocks: Set<bigint>
): Promise<Map<string, DBUnshield[]>> {
  const byTxid = new Map<string, DBUnshield[]>()
  for (const block of blocks) {
    const events = await chainStorage.getUnshieldsByBlockRange(block, block)
    for (const event of events) {
      const txid = bytesToHex(event.transactionHash, { prefix: true })
      const existing = byTxid.get(txid)
      if (existing === undefined) {
        byTxid.set(txid, [event])
        continue
      }
      existing.push(event)
    }
  }
  return byTxid
}

/**
 * Describe an unshield event, naming the token it moved.
 *
 * The event's own token is used when the chain data carries it. Databases
 * scanned before unshield tokens were persisted fall back to the token of
 * the notes the transaction spent, which is the same token whenever a
 * transaction moves one.
 * @param event - Stored unshield event.
 * @param spent - Amounts the transaction spent from this wallet.
 * @returns The unshielded amount in public form.
 */
function toUnshieldAmount (
  event: DBUnshield,
  spent: HistoryTokenAmount[]
): UnshieldTokenAmount {
  const eventToken = event.token as
    | {
      tokenAddress?: Uint8Array
      tokenSubID?: Uint8Array
      tokenType?: number | string
    }
    | null
    | undefined
  const fallback = spent[0]
  const token = eventToken?.tokenAddress !== undefined
    ? bytesToHex(eventToken.tokenAddress, { prefix: true }).toLowerCase()
    : fallback?.token ?? ''
  const tokenSubID = eventToken?.tokenSubID !== undefined
    ? bytesToHex(eventToken.tokenSubID, { prefix: true })
    : fallback?.tokenSubID ?? ''
  const tokenType = eventToken?.tokenType !== undefined
    ? toTokenType(eventToken.tokenType)
    : fallback?.tokenType ?? TokenType.ERC20

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
  const amount: HistoryTokenAmount = {
    token: metadata.token ?? '',
    tokenType: metadata.tokenType === undefined
      ? TokenType.ERC20
      : toTokenType(metadata.tokenType),
    tokenSubID: metadata.tokenSubID ?? ERC20_TOKEN_SUB_ID,
    amount: metadata.amount === undefined ? 0n : BigInt(metadata.amount)
  }

  return {
    txid: row.txid,
    blockNumber: row.blockNumber,
    timestamp: row.timestamp,
    category: row.type === 'unshield' ? 'unshield' : row.type === 'transfer' ? 'send' : 'shield',
    received: row.type === 'shield' ? [{ ...amount, kind: 'shield' }] : [],
    spent: row.type === 'shield' ? [] : [amount],
    transferred: row.type === 'transfer' ? [amount] : [],
    unshields: row.type === 'unshield' ? [{ ...amount, fee: 0n, toAddress: '' }] : [],
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
      spentBlocks
    )
    for (const draft of drafts.values()) {
      const events = unshieldsByTxid.get(draft.txid)
      if (events === undefined) continue
      for (const event of events) {
        draft.unshields.push(toUnshieldAmount(event, draft.spent))
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
