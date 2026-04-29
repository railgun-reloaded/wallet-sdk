import {
  decryptActions,
  storeDecryptedNotes
} from '@railgun-reloaded/balance-scanner'
import type {
  ChainDB,
  DBCommitment,
  DBNullifier,
  WalletDB
} from '@railgun-reloaded/storage'
import {
  getCommitmentsByBlockRange,
  getNullifiersByBlockRange,
  getScanState,
  getSyncState,
  getUnspentNotes,
  markNotesSpentBatch,
  recalculateAllBalances,
  updateScanState
} from '@railgun-reloaded/storage'
import type { Chain } from '@railgun-reloaded/wallet-node'
import { ChainType, uint8ArrayToHex } from '@railgun-reloaded/wallet-node'

import type { WalletContext } from '../services/wallet/wallet-service'

import { rehydrateActions } from './event-rehydrator'
import { erc20TokenDataGetter } from './token-data'

enum SyncPhase {
  Scan = 'scan',
  Decrypt = 'decrypt'
}

/**
 * Per-batch progress event fired by sync/scan/decrypt. `phase` separates the
 * two stages because they have very different throughput; UIs typically show
 * them as two progress bars.
 */
type SyncProgress = {
  phase: SyncPhase
  fromBlock: bigint
  toBlock: bigint
  /** Last block of the batch just finished. Monotonic across a single run. */
  currentBlock: bigint
  /** Running total of blocks processed since the run began. */
  blocksScanned: bigint
  /** Running total of decrypted notes inserted (decrypt phase only). */
  notesAdded: number
  /** Running total of owned notes marked spent (decrypt phase only). */
  notesSpent: number
}

/**
 * Inputs for `runWalletDecryption`.
 */
type WalletDecryptionParams = {
  chainDb: ChainDB
  walletDb: WalletDB
  walletContext: WalletContext
  chainId: number
  /** Defaults to `scanState.lastScannedBlock + 1` (or `0n` for a fresh wallet). */
  fromBlock?: bigint
  /** Defaults to `chainSyncState.lastBlockHeight` (don't read past chain.db). */
  toBlock?: bigint
  /** Block-range chunk size for chain.db queries. Defaults to 10_000. */
  batchSize?: bigint
  /** Fired after each batch's cursor advance. Synchronous; throwing aborts the run. */
  onProgress?: (progress: SyncProgress) => void
}

/**
 * Result of a decryption pass over a block range.
 */
type DecryptSummary = {
  walletId: string
  chainId: number
  fromBlock: bigint
  toBlock: bigint
  blocksScanned: bigint
  notesAdded: number
  notesSpent: number
}

const DEFAULT_BATCH_SIZE = 10_000n

/**
 * Group chain commitment rows by their block number, preserving query order
 * within each group. Used to feed `decryptActions` per-block so the resulting
 * `DecryptedNote.blockNumber` matches the block the commitment came from.
 * @param rows - Chain rows from `getCommitmentsByBlockRange`.
 * @returns Map keyed by block number (bigint) with the rows that landed there.
 */
function groupCommitmentsByBlock (rows: DBCommitment[]): Map<bigint, DBCommitment[]> {
  const groups = new Map<bigint, DBCommitment[]>()
  for (const row of rows) {
    const list = groups.get(row.blockNumber)
    if (list) {
      list.push(row)
    } else {
      groups.set(row.blockNumber, [row])
    }
  }
  return groups
}

/**
 * Group chain nullifier rows by their block number. Built once per batch so
 * the per-block loop can do an O(1) lookup instead of re-filtering the full
 * array on every iteration.
 * @param rows - Chain rows from `getNullifiersByBlockRange`.
 * @returns Map keyed by block number with the nullifier rows that landed there.
 */
function groupNullifiersByBlock (rows: DBNullifier[]): Map<bigint, DBNullifier[]> {
  const groups = new Map<bigint, DBNullifier[]>()
  for (const row of rows) {
    const list = groups.get(row.blockNumber)
    if (list) {
      list.push(row)
    } else {
      groups.set(row.blockNumber, [row])
    }
  }
  return groups
}

/**
 * Decrypt and persist all notes for a wallet over a block range read from
 * chain.db. Idempotent: re-running over the same range against the same
 * wallet.db is a no-op for inserted notes (commitment is the primary key)
 * and spent flags (already marked).
 *
 * Pure consumer of chain.db — does not invoke the engine. Run `client.scan()`
 * (or `engine.scan()`) first to populate chain.db, then call this to
 * decrypt for each wallet.
 * @param params - Inputs; see `WalletDecryptionParams`.
 * @returns Summary: blocks scanned, notes added, notes spent.
 */
async function runWalletDecryption (
  params: WalletDecryptionParams
): Promise<DecryptSummary> {
  const { chainDb, walletDb, walletContext, chainId } = params
  const { walletId } = walletContext

  const persistedCursor = getScanState(walletDb, walletId, chainId)?.lastScannedBlock
  const resolvedFrom = params.fromBlock ??
    (persistedCursor !== undefined ? persistedCursor + 1n : 0n)

  const chainTip = getSyncState(chainDb, chainId)?.lastBlockHeight
  const resolvedTo = params.toBlock ?? chainTip

  if (resolvedTo === undefined || resolvedFrom > resolvedTo) {
    return {
      walletId,
      chainId,
      fromBlock: resolvedFrom,
      toBlock: resolvedTo ?? resolvedFrom,
      blocksScanned: 0n,
      notesAdded: 0,
      notesSpent: 0
    }
  }

  const chain: Chain = { type: ChainType.EVM, id: chainId }
  const batchSize = params.batchSize ?? DEFAULT_BATCH_SIZE

  let notesAdded = 0
  let notesSpent = 0

  for (let batchFrom = resolvedFrom; batchFrom <= resolvedTo; batchFrom += batchSize) {
    const batchTo = batchFrom + batchSize - 1n > resolvedTo
      ? resolvedTo
      : batchFrom + batchSize - 1n

    const commitmentRows = getCommitmentsByBlockRange(chainDb, batchFrom, batchTo)
    const nullifierRows = getNullifiersByBlockRange(chainDb, batchFrom, batchTo)

    if (commitmentRows.length > 0) {
      const blockGroups = groupCommitmentsByBlock(commitmentRows)
      const nullifiersByBlock = groupNullifiersByBlock(nullifierRows)
      for (const [blockNumber, rows] of blockGroups) {
        const blockNullifiers = nullifiersByBlock.get(blockNumber) ?? []
        const { shields, transacts } = rehydrateActions({
          commitments: rows,
          nullifiers: blockNullifiers
        })

        const { receivedNotes } = await decryptActions(
          [...shields, ...transacts],
          {
            chain,
            walletId,
            txid: '',
            viewingPrivateKey: walletContext.viewingPrivateKey,
            viewingPublicKey: walletContext.viewingPublicKey,
            masterPublicKey: walletContext.masterPublicKey,
            nullifyingKey: walletContext.nullifyingKey,
            blockNumber,
            tokenDataGetter: erc20TokenDataGetter
          }
        )

        if (receivedNotes.length > 0) {
          notesAdded += storeDecryptedNotes(walletDb, receivedNotes)
        }
      }
    }

    if (nullifierRows.length > 0) {
      const ownedNotes = getUnspentNotes(walletDb, walletId)
      if (ownedNotes.length > 0) {
        const ownedByNullifier = new Map<string, Uint8Array>()
        for (const note of ownedNotes) {
          ownedByNullifier.set(uint8ArrayToHex(note.nullifier), note.commitment)
        }

        const spendsByTxid = new Map<string, { txHash: Uint8Array, commitments: Uint8Array[] }>()
        for (const row of nullifierRows) {
          const commitment = ownedByNullifier.get(uint8ArrayToHex(row.nullifier))
          if (!commitment) continue
          const txKey = uint8ArrayToHex(row.transactionHash)
          const bucket = spendsByTxid.get(txKey)
          if (bucket) {
            bucket.commitments.push(commitment)
          } else {
            spendsByTxid.set(txKey, { txHash: row.transactionHash, commitments: [commitment] })
          }
        }

        for (const { txHash, commitments } of spendsByTxid.values()) {
          notesSpent += markNotesSpentBatch(walletDb, commitments, txHash)
        }
      }
    }

    updateScanState(walletDb, walletId, chainId, batchTo)

    params.onProgress?.({
      phase: SyncPhase.Decrypt,
      fromBlock: resolvedFrom,
      toBlock: resolvedTo,
      currentBlock: batchTo,
      blocksScanned: batchTo - resolvedFrom + 1n,
      notesAdded,
      notesSpent
    })
  }

  if (notesAdded > 0 || notesSpent > 0) {
    recalculateAllBalances(walletDb, walletId)
  }

  return {
    walletId,
    chainId,
    fromBlock: resolvedFrom,
    toBlock: resolvedTo,
    blocksScanned: resolvedTo - resolvedFrom + 1n,
    notesAdded,
    notesSpent
  }
}

export { runWalletDecryption, SyncPhase }
export type { DecryptSummary, SyncProgress, WalletDecryptionParams }
