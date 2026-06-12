import type { DecryptedNote } from '@railgun-reloaded/balance-scanner'
import {
  decryptActions,
  storeDecryptedNotes
} from '@railgun-reloaded/balance-scanner'
import { bytesToHex } from '@railgun-reloaded/bytes'
import type {
  ChainDB,
  DBCommitment,
  DBNullifier,
  NoteIdentity,
  WalletDB
} from '@railgun-reloaded/storage'
import {
  findRailgunTransactionForLeaf,
  getCommitmentsByBlockRange,
  getNullifiersByBlockRange,
  getScanState,
  getSyncState,
  getUnspentNotes,
  markNotesSpentBatch,
  updateScanState
} from '@railgun-reloaded/storage'
import type { Chain } from '@railgun-reloaded/wallet-node'
import { ChainType } from '@railgun-reloaded/wallet-node'

import type { WalletContext } from '../services/wallet/wallet-service'

import { rehydrateActions } from './event-rehydrator'
import { erc20TokenDataGetter } from './token-data'

enum SyncPhase {
  Scan = 'scan',
  Decrypt = 'decrypt',
  PoiRefresh = 'poi-refresh'
}

type PoiRefreshProgressSummary = {
  checked: number
  updated: number
  skipped: number
  failed: number
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
  /** Running total of POI status refresh results (POI refresh phase only). */
  poi?: PoiRefreshProgressSummary
  /** Typed refresh error when a PPOI node request fails. */
  error?: Error
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
 * Index a window of chain commitment rows by `(treeNumber, treePosition)` so
 * the enrichment step can look up the originating EVM transaction hash for a
 * decrypted note in O(1).
 * @param rows - Chain commitment rows for the current batch.
 * @returns Map keyed by `"treeNumber:treePosition"` to the chain row.
 */
function indexCommitmentsByLeaf (rows: DBCommitment[]): Map<string, DBCommitment> {
  const index = new Map<string, DBCommitment>()
  for (const row of rows) {
    index.set(`${row.treeNumber}:${row.treePosition}`, row)
  }
  return index
}

/**
 * Attach PPOI metadata (`chainId`, `creationTxid`, `creationRailgunTxid`) to
 * decrypted notes before they reach `storeDecryptedNotes`. `creationTxid`
 * comes from the chain commitment row that produced the note; the
 * `creationRailgunTxid` join walks `railgun_transactions` to find the
 * Railgun-side tx whose output batch contains the note's slot. If no row in
 * `railgun_transactions` covers the slot (RPC-only source), the field stays
 * undefined and downstream POI refresh treats the note as un-refreshable.
 * @param notes - Decrypted notes returned by `decryptActions`.
 * @param chainId - Chain id the sync is running for.
 * @param chainDb - Chain database, queried for the railgun-tx join.
 * @param commitmentsByLeaf - Per-batch index of chain commitments keyed by leaf.
 * @returns The same notes with PPOI metadata fields populated where possible.
 */
async function enrichDecryptedNotes (
  notes: DecryptedNote[],
  chainId: number,
  chainDb: ChainDB,
  commitmentsByLeaf: Map<string, DBCommitment>
): Promise<DecryptedNote[]> {
  const enrichedNotes: DecryptedNote[] = []
  for (const note of notes) {
    const leafIndex = Number(note.leafIndex)
    const commitmentRow = commitmentsByLeaf.get(`${note.treeId}:${leafIndex}`)
    const railgunTx = await findRailgunTransactionForLeaf(chainDb, note.treeId, leafIndex)
    const enriched: DecryptedNote = { ...note, chainId }
    if (commitmentRow !== undefined) {
      enriched.creationTxid = commitmentRow.transactionHash
    }
    if (railgunTx !== undefined) {
      enriched.creationRailgunTxid = railgunTx.railgunTxid
    }
    enrichedNotes.push(enriched)
  }
  return enrichedNotes
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

  const persistedCursor = (await getScanState(walletDb, walletId, chainId))?.lastScannedBlock
  const resolvedFrom = params.fromBlock ??
    (persistedCursor !== undefined ? persistedCursor + 1n : 0n)

  const chainTip = (await getSyncState(chainDb, chainId))?.lastBlockHeight
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

    const commitmentRows = await getCommitmentsByBlockRange(chainDb, batchFrom, batchTo)
    const nullifierRows = await getNullifiersByBlockRange(chainDb, batchFrom, batchTo)

    if (commitmentRows.length > 0) {
      const blockGroups = groupCommitmentsByBlock(commitmentRows)
      const nullifiersByBlock = groupNullifiersByBlock(nullifierRows)
      const commitmentsByLeaf = indexCommitmentsByLeaf(commitmentRows)
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
          const enriched = await enrichDecryptedNotes(
            receivedNotes,
            chainId,
            chainDb,
            commitmentsByLeaf
          )
          notesAdded += await storeDecryptedNotes(walletDb, enriched)
        }
      }
    }

    if (nullifierRows.length > 0) {
      const ownedNotes = await getUnspentNotes(walletDb, walletId, chainId)
      if (ownedNotes.length > 0) {
        const ownedByNullifier = new Map<string, NoteIdentity>()
        for (const note of ownedNotes) {
          ownedByNullifier.set(nullifierKey(note.nullifier, note.treeNumber), {
            walletId: note.walletId,
            chainId: note.chainId,
            commitment: note.commitment
          })
        }

        const spendsByTxid = new Map<string, { txHash: Uint8Array, identities: NoteIdentity[] }>()
        for (const row of nullifierRows) {
          const identity = ownedByNullifier.get(nullifierKey(row.nullifier, row.treeNumber))
          if (!identity) continue
          const txKey = bytesToHex(row.transactionHash)
          const bucket = spendsByTxid.get(txKey)
          if (bucket) {
            bucket.identities.push(identity)
          } else {
            spendsByTxid.set(txKey, { txHash: row.transactionHash, identities: [identity] })
          }
        }

        for (const { txHash, identities } of spendsByTxid.values()) {
          notesSpent += await markNotesSpentBatch(walletDb, identities, txHash)
        }
      }
    }

    await updateScanState(walletDb, walletId, chainId, batchTo)

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

/**
 * Build a stable key for a nullifier scoped to one tree.
 * @param nullifier - Nullifier bytes.
 * @param treeNumber - Tree number containing the nullifier.
 * @returns String key for map lookups.
 */
function nullifierKey (nullifier: Uint8Array, treeNumber: number): string {
  return `${bytesToHex(nullifier)}:${treeNumber}`
}

export { runWalletDecryption, SyncPhase }
export type {
  DecryptSummary,
  PoiRefreshProgressSummary,
  SyncProgress,
  WalletDecryptionParams
}
