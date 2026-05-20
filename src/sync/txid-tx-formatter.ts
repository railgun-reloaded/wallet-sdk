import type { EVMBlock, Token, Transact } from '@railgun-reloaded/scanner'
import { ActionType } from '@railgun-reloaded/scanner'
import type { DBNewRailgunTransaction } from '@railgun-reloaded/storage'

const RAILGUN_TXID_BYTE_LENGTH = 32

enum RailgunTransactionTxidVersion {
  V2 = 2,
  V3 = 3,
}

type RailgunTransactionUnshieldData = {
  to: Uint8Array
  token: Token
  value: bigint
}

/**
 * Convert scanner block Transact actions into chain.db Railgun transaction rows.
 * RPC currently cannot provide complete PPOI fields, so incomplete Transact
 * actions are ignored and do not advance the TXID cursor.
 * @param block - Scanner block data from a PPOI-complete source.
 * @param txidVersion - Railgun transaction version to store.
 * @returns Railgun transaction rows ready for insertion.
 */
function formatRailgunTransactions (
  block: EVMBlock,
  txidVersion: RailgunTransactionTxidVersion = RailgunTransactionTxidVersion.V2
): DBNewRailgunTransaction[] {
  const railgunTransactions = new Array<DBNewRailgunTransaction>()

  for (const tx of block.transactions) {
    const actions = tx.actions.flat()
    for (const action of actions) {
      if (
        action.actionType !== ActionType.TransactCommitment &&
        action.actionType !== ActionType.EncryptedCommitment
      ) {
        continue
      }

      const transact = action as Transact
      if (!isPpoiCompleteTransact(transact)) {
        continue
      }

      railgunTransactions.push({
        railgunTxid: normalizeBytes32(transact.txID),
        txidVersion,
        chainTxid: normalizeBytes32(tx.hash),
        graphID: null,
        blockNumber: block.number,
        timestamp: block.timestamp,
        nullifiers: transact.nullifiers.map(normalizeBytes32),
        commitments: transact.commitments.map(commitment =>
          normalizeBytes32(commitment.hash)
        ),
        boundParamsHash: normalizeBytes32(transact.boundParamsHash),
        hasUnshield: transact.hasUnshield,
        unshield: formatUnshield(transact),
        utxoTreeIn: transact.utxoTreeIn,
        utxoTreeOut: transact.utxoTreeOut,
        utxoBatchStartPositionOut: transact.utxoBatchStartPositionOut,
        verificationHash: null,
      })
    }
  }

  return railgunTransactions
}

/**
 * Identify Transact actions with all fields required for M1 read-side PPOI.
 * @param transact - Scanner Transact action.
 * @returns True when the action can be persisted as a Railgun transaction row.
 */
function isPpoiCompleteTransact (transact: Transact): boolean {
  if (
    !isBytes32(transact.txID) ||
    !isBytes32(transact.boundParamsHash) ||
    !transact.nullifiers.every(isBytes32) ||
    !transact.commitments.every(commitment => isBytes32(commitment.hash))
  ) {
    return false
  }

  if (!transact.hasUnshield) {
    return true
  }

  if (
    transact.unshieldToAddress === undefined ||
    transact.unshieldToken === undefined ||
    transact.unshieldValue === undefined
  ) {
    throw new Error('PPOI-complete Transact unshield is missing unshield data')
  }

  return true
}

/**
 * Format unshield metadata for storage.
 * @param transact - Scanner Transact action.
 * @returns Unshield data when present.
 */
function formatUnshield (transact: Transact): RailgunTransactionUnshieldData | null {
  if (!transact.hasUnshield) {
    return null
  }

  return {
    to: transact.unshieldToAddress!,
    token: transact.unshieldToken!,
    value: transact.unshieldValue!,
  }
}

/**
 * Check that a byte array is already canonical 32 bytes.
 * @param value - Byte array.
 * @returns True when length is exactly 32.
 */
function isBytes32 (value: Uint8Array): boolean {
  return value.length === RAILGUN_TXID_BYTE_LENGTH
}

/**
 * Normalize a byte array to 32 bytes, throwing only when it is too long.
 * @param value - Byte array to normalize.
 * @returns 32-byte array.
 */
function normalizeBytes32 (value: Uint8Array): Uint8Array {
  if (value.length > RAILGUN_TXID_BYTE_LENGTH) {
    throw new Error(`Expected at most ${RAILGUN_TXID_BYTE_LENGTH} bytes`)
  }

  if (value.length === RAILGUN_TXID_BYTE_LENGTH) {
    return value
  }

  const padded = new Uint8Array(RAILGUN_TXID_BYTE_LENGTH)
  padded.set(value, RAILGUN_TXID_BYTE_LENGTH - value.length)
  return padded
}

export {
  formatRailgunTransactions,
  isPpoiCompleteTransact,
  RailgunTransactionTxidVersion,
}
export type { RailgunTransactionUnshieldData }
