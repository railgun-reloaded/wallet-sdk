import type { TokenType } from '@railgun-reloaded/wallet-node'

import type { NoteSpendState } from '../poi/types.js'

/** A token and how much of it moved. */
type HistoryTokenAmount = {
  /** ERC-20 or ERC-721 contract address, lowercased. */
  token: string
  /** Standard the token follows. */
  tokenType: TokenType
  /** 32-byte token sub-ID as 0x-prefixed hex; zero for ERC-20. */
  tokenSubID: string
  /** Amount in the token's base units. */
  amount: bigint
}

/**
 * Why a note arrived in the wallet.
 *
 * `shield` comes from the commitment type. `change` comes from the sender
 * annotation, which only decrypts for outputs this wallet created, so a note
 * received from someone else reads as `transfer`.
 */
type ReceivedKind = 'shield' | 'transfer' | 'change'

/** A token amount the wallet received, and why. */
type ReceivedTokenAmount = HistoryTokenAmount & {
  /** Where the note came from. */
  kind: ReceivedKind
}

/** A token amount that left the private balance to a public address. */
type UnshieldTokenAmount = HistoryTokenAmount & {
  /** Protocol fee taken from the unshielded amount. */
  fee: bigint
  /** Public address that received the value. */
  toAddress: string
}

/**
 * What a transaction did, as far as this wallet is concerned. Derived from
 * which amounts the transaction moved, not stored on chain.
 */
type TransactionCategory = 'shield' | 'unshield' | 'send' | 'receive'

/** One transaction, with every amount it moved for this wallet. */
type TransactionHistoryEntry = {
  /** Ethereum transaction hash, 0x-prefixed. */
  txid: string
  /** Block the transaction was mined in. */
  blockNumber: bigint
  /** When the block was mined, when the chain data carries it. */
  timestamp: Date | null
  /** What the transaction did for this wallet. */
  category: TransactionCategory
  /** Notes the transaction created for this wallet. */
  received: ReceivedTokenAmount[]
  /** Notes of this wallet the transaction spent. */
  spent: HistoryTokenAmount[]
  /**
   * What the transaction moved to another private address, per token. Derived
   * from `spent`, less change and less anything unshielded. Includes any
   * broadcaster fee, which is paid to a note this wallet does not hold.
   */
  transferred: HistoryTokenAmount[]
  /**
   * Amounts this wallet moved out to a public address. One transaction can
   * carry the Railgun transactions of several wallets, so an unshield is
   * attributed through the nullifiers of the notes this wallet spent. A
   * transaction whose Railgun transactions were not recorded carries no such
   * evidence, and reports every unshield under its hash.
   */
  unshields: UnshieldTokenAmount[]
  /**
   * PPOI state across the notes this transaction created. Reports the least
   * settled of them, so a transaction is only `cleared` once all of its
   * notes are. Null when the transaction created no notes for this wallet.
   */
  spendState: NoteSpendState | null
  /**
   * True while the entry comes from a transaction the wallet recorded itself
   * and decryption has not reached yet.
   */
  pending: boolean
}

export type {
  HistoryTokenAmount,
  ReceivedKind,
  ReceivedTokenAmount,
  TransactionCategory,
  TransactionHistoryEntry,
  UnshieldTokenAmount
}
