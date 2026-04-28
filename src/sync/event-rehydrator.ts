import type {
  EncryptedCommitment,
  GeneratedCommitment,
  Shield,
  ShieldCommitment,
  Transact,
  TransactCommitment
} from '@railgun-reloaded/scanner'
import { ActionType } from '@railgun-reloaded/scanner'
import type { DBCommitment, DBNullifier } from '@railgun-reloaded/storage'

import { CommitmentType } from './event-processor'

/**
 * Output of rehydrating a chain.db window into scanner-shaped actions.
 * `decryptActions` from balance-scanner consumes the same shapes the scanner
 * originally yielded.
 */
type RehydratedActions = {
  shields: Shield[]
  transacts: Transact[]
}

/**
 * Re-attach the hash/tree fields that `denormalizeBlockData` strips off the
 * inner commitment blob and back onto a scanner-shaped commitment.
 * @param row - The chain commitment row.
 * @returns Object with the inner blob's fields plus `hash`, `treeNumber`,
 *   `treePosition` reattached.
 */
function attachCommitmentColumns (row: DBCommitment): Record<string, unknown> {
  return {
    ...(row.commitment as Record<string, unknown>),
    hash: row.hash,
    treeNumber: row.treeNumber,
    treePosition: row.treePosition,
  }
}

/**
 * Rebuild a scanner-shaped Shield action from one chain.db commitment row.
 * Discriminates `GeneratedCommitment` vs `ShieldCommitment` by the presence
 * of `encryptedRandom` on the inner blob (matches `processShieldAction`).
 * @param row - Chain commitment row with `commitmentType === CommitmentType.Shield`.
 * @returns Reconstructed Shield action.
 */
function rehydrateShield (row: DBCommitment): Shield {
  const commitment = attachCommitmentColumns(row)
  const isGenerated = 'encryptedRandom' in commitment
  return {
    actionType: isGenerated
      ? ActionType.GeneratedCommitment
      : ActionType.ShieldCommitment,
    batchStartTreePosition: 0,
    commitment: commitment as unknown as (GeneratedCommitment | ShieldCommitment),
  }
}

/**
 * Rebuild a scanner-shaped TransactCommitment / EncryptedCommitment from one
 * chain.db commitment row. Discriminates by the presence of `ephemeralKeys`
 * on the inner blob (matches `processTransactAction`).
 * @param row - Chain commitment row with `commitmentType === CommitmentType.Transact`.
 * @returns Reconstructed TransactCommitment or EncryptedCommitment.
 */
function rehydrateTransactCommitment (
  row: DBCommitment
): TransactCommitment | EncryptedCommitment {
  const commitment = attachCommitmentColumns(row)
  return commitment as unknown as (TransactCommitment | EncryptedCommitment)
}

/**
 * Convert chain.db rows back into scanner-shaped Shield / Transact actions
 * for re-decryption. Pure function: no DB reads, no side effects. Inverse of
 * `denormalizeBlockData` for the fields balance-scanner consumes; protocol
 * fields not persisted (txID, boundParamsHash, utxo* offsets, unshield flags)
 * default to zero/empty since `decryptActions` does not read them.
 *
 * Transact actions are grouped by `(transactionHash, treeNumber)` so multiple
 * Transact commitments that landed in the same tx and tree are emitted as a
 * single action with their nullifiers re-attached.
 * @param rows - Chain rows fetched via `getCommitmentsByBlockRange` and
 *   `getNullifiersByBlockRange` for the same window.
 * @param rows.commitments - Commitment rows.
 * @param rows.nullifiers - Nullifier rows from the same block range.
 * @returns Shields ready for `processShieldAction` and Transacts ready for
 *   `processTransactAction`.
 */
function rehydrateActions (rows: {
  commitments: DBCommitment[]
  nullifiers: DBNullifier[]
}): RehydratedActions {
  const shields: Shield[] = []
  const transactGroups = new Map<string, {
    transactionHash: Uint8Array
    treeNumber: number
    commitments: (TransactCommitment | EncryptedCommitment)[]
  }>()

  for (const row of rows.commitments) {
    if (row.commitmentType === CommitmentType.Shield) {
      shields.push(rehydrateShield(row))
      continue
    }

    if (row.commitmentType === CommitmentType.Transact) {
      const key = `${Buffer.from(row.transactionHash).toString('hex')}:${row.treeNumber}`
      let group = transactGroups.get(key)
      if (!group) {
        group = {
          transactionHash: row.transactionHash,
          treeNumber: row.treeNumber,
          commitments: [],
        }
        transactGroups.set(key, group)
      }
      group.commitments.push(rehydrateTransactCommitment(row))
    }
  }

  const nullifiersByGroup = new Map<string, Uint8Array[]>()
  for (const row of rows.nullifiers) {
    const key = `${Buffer.from(row.transactionHash).toString('hex')}:${row.treeNumber}`
    const list = nullifiersByGroup.get(key)
    if (list) {
      list.push(row.nullifier)
    } else {
      nullifiersByGroup.set(key, [row.nullifier])
    }
  }

  const transacts: Transact[] = []
  for (const [key, group] of transactGroups) {
    transacts.push({
      actionType: ActionType.TransactCommitment,
      txID: group.transactionHash,
      nullifiers: nullifiersByGroup.get(key) ?? [],
      commitments: group.commitments,
      boundParamsHash: new Uint8Array(),
      utxoBatchStartPositionOut: 0,
      utxoTreeIn: group.treeNumber,
      utxoTreeOut: group.treeNumber,
      hasUnshield: false,
    })
  }

  return { shields, transacts }
}

export { rehydrateActions }
export type { RehydratedActions }
