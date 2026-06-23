import { bytesToBigInt, bytesToHex } from '@railgun-reloaded/bytes'
import type { DBNote, NoteIdentity, NotePoiStatusUpdate, WalletDB } from '@railgun-reloaded/storage'
import {
  getNotesNeedingPoiRefresh,
  updateNotePoiStatusBatch
} from '@railgun-reloaded/storage'

import type { NetworkName } from '../network-config.js'
import type { SyncProgress } from '../sync/wallet-decryptor.js'
import { SyncPhase } from '../sync/wallet-decryptor.js'

import { getBlindedCommitmentForShieldOrTransact } from './blinded-commitment.js'
import { getRequiredListKeys } from './network-config.js'
import {
  PoiNodeAllUrlsFailedError,
  PoiNodeNetworkError
} from './node-client-errors.js'
import type { GetPOIsPerListParams } from './node-client-types.js'
import { PoiStatusRefreshError } from './status-errors.js'
import type { RequiredListKey } from './types.js'
import { BlindedCommitmentType, TXIDVersion } from './types.js'

type RefreshSummary = {
  checked: number
  updated: number
  skipped: number
  failed: number
}

type PoiStatusClient = Pick<PoiNodeClient, 'getPOIsPerList'>

type PoiStatusServiceOptions = {
  walletDb: WalletDB
  poiNodeClient: PoiStatusClient
  network: NetworkName
  listKeys?: RequiredListKey[]
  txidVersion?: TXIDVersion
}

type RefreshOptions = {
  onProgress?: (progress: SyncProgress) => void
}

type RefreshEntry = NoteIdentity & {
  blindedCommitment: Uint8Array
  blindedCommitmentHex: string
  type: BlindedCommitmentType.Shield | BlindedCommitmentType.Transact
}

const SHIELD_COMMITMENT_TYPE = 0
const TRANSACT_COMMITMENT_TYPE = 1
const TREE_LEAF_COUNT = 65536n
const ZERO_BLOCK = 0n

/**
 * Refreshes stored note PPOI statuses from a PPOI node.
 */
class PoiStatusService {
  /** Wallet database containing decrypted notes. */
  readonly #walletDb: WalletDB
  /** PPOI node client used for status lookups. */
  readonly #poiNodeClient: PoiStatusClient
  /** Network whose PPOI config is being refreshed. */
  readonly #network: NetworkName
  /** Required PPOI list keys to check. */
  readonly #listKeys: RequiredListKey[]
  /** TXID version sent to the PPOI node. */
  readonly #txidVersion: TXIDVersion

  /**
   * Build a PPOI status refresh service.
   * @param options - Wallet DB, node client, network, and optional list config.
   */
  constructor (options: PoiStatusServiceOptions) {
    this.#walletDb = options.walletDb
    this.#poiNodeClient = options.poiNodeClient
    this.#network = options.network
    this.#listKeys = options.listKeys ?? getRequiredListKeys(options.network)
    this.#txidVersion = options.txidVersion ?? TXIDVersion.V2_PoseidonMerkle
  }

  /**
   * Refresh persisted PPOI status for candidate notes in one wallet.
   * @param walletId - Wallet whose notes should be refreshed.
   * @param chainId - Chain ID to scope note reads and writes.
   * @param options - Optional progress callback.
   * @returns Refresh summary counters.
   */
  async refresh (
    walletId: string,
    chainId: number,
    options: RefreshOptions = {}
  ): Promise<RefreshSummary> {
    const candidates = await getNotesNeedingPoiRefresh(
      this.#walletDb,
      walletId,
      chainId
    )
    const summary: RefreshSummary = {
      checked: candidates.length,
      updated: 0,
      skipped: 0,
      failed: 0
    }
    const entries: RefreshEntry[] = []

    for (const note of candidates) {
      try {
        entries.push(noteToRefreshEntry(note))
      } catch (error) {
        summary.failed += 1
        emitPoiProgress(options.onProgress, summary, new PoiStatusRefreshError({
          code: 'BlindedCommitmentDerivationFailed',
          walletId: note.walletId,
          chainId: note.chainId,
          message: 'Failed to derive blinded commitment for received note',
          cause: error
        }))
      }
    }

    if (this.#listKeys.length === 0) {
      summary.skipped += entries.length
      emitPoiProgress(options.onProgress, summary)
      return summary
    }

    for (const batch of chunk(entries, GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS)) {
      await this.#refreshEntries(batch, summary, options.onProgress)
    }

    emitPoiProgress(options.onProgress, summary)
    return summary
  }

  /**
   * Refresh one batch of blinded commitments, splitting retryable failures.
   * @param entries - Candidate note entries for this batch.
   * @param summary - Mutable summary counters for the full refresh.
   * @param onProgress - Optional progress callback.
   */
  async #refreshEntries (
    entries: RefreshEntry[],
    summary: RefreshSummary,
    onProgress: RefreshOptions['onProgress']
  ): Promise<void> {
    if (entries.length === 0) return

    let response: Awaited<ReturnType<PoiStatusClient['getPOIsPerList']>>
    try {
      response = await this.#poiNodeClient.getPOIsPerList({
        network: this.#network,
        txidVersion: this.#txidVersion,
        listKeys: this.#listKeys,
        blindedCommitmentDatas: entries.map(entry => ({
          blindedCommitment: entry.blindedCommitmentHex,
          type: entry.type
        }))
      } satisfies GetPOIsPerListParams)
    } catch (error) {
      const typedError = toError(error)
      if (entries.length > 1 && shouldSplitFailure(typedError)) {
        const middle = Math.floor(entries.length / 2)
        await this.#refreshEntries(entries.slice(0, middle), summary, onProgress)
        await this.#refreshEntries(entries.slice(middle), summary, onProgress)
        return
      }

      summary.failed += entries.length
      emitPoiProgress(onProgress, summary, typedError)
      return
    }

    const updates: NotePoiStatusUpdate[] = []
    const missingEntries: RefreshEntry[] = []
    for (const entry of entries) {
      const poisPerList = response[entry.blindedCommitmentHex]
      if (poisPerList === undefined) {
        missingEntries.push(entry)
        continue
      }
      updates.push({
        walletId: entry.walletId,
        chainId: entry.chainId,
        commitment: entry.commitment,
        blindedCommitment: entry.blindedCommitment,
        poisPerList
      })
    }

    if (updates.length > 0) {
      try {
        const persisted = await updateNotePoiStatusBatch(this.#walletDb, updates)
        summary.updated += persisted
        if (persisted < updates.length) {
          summary.failed += updates.length - persisted
          emitPoiProgress(onProgress, summary, new PoiStatusRefreshError({
            code: 'StatusPersistenceFailed',
            walletId: entries[0]!.walletId,
            chainId: entries[0]!.chainId,
            message: `Failed to persist ${updates.length - persisted} POI status update(s)`
          }))
        }
      } catch (error) {
        summary.failed += updates.length
        emitPoiProgress(onProgress, summary, new PoiStatusRefreshError({
          code: 'StatusPersistenceFailed',
          walletId: entries[0]!.walletId,
          chainId: entries[0]!.chainId,
          message: `Failed to persist ${updates.length} POI status update(s)`,
          cause: error
        }))
      }
    }

    if (missingEntries.length > 0) {
      summary.failed += missingEntries.length
      emitPoiProgress(onProgress, summary, new PoiStatusRefreshError({
        code: 'MissingStatusResponse',
        walletId: missingEntries[0]!.walletId,
        chainId: missingEntries[0]!.chainId,
        message: `PPOI node omitted ${missingEntries.length} requested status result(s)`
      }))
    }

    emitPoiProgress(onProgress, summary)
  }
}

/**
 * Convert a note row into a PPOI node request entry.
 * @param note - Stored note row.
 * @returns Request entry with blinded commitment metadata.
 */
function noteToRefreshEntry (note: DBNote): RefreshEntry {
  const type = getBlindedCommitmentType(note.commitmentType)
  const blindedCommitment = note.blindedCommitment ??
    deriveBlindedCommitment(note)

  return {
    walletId: note.walletId,
    chainId: note.chainId,
    commitment: note.commitment,
    blindedCommitment,
    blindedCommitmentHex: bytesToHex(blindedCommitment, { prefix: true }),
    type
  }
}

/**
 * Map storage commitment type integers to PPOI blinded commitment types.
 * @param commitmentType - Stored note commitment type.
 * @returns PPOI blinded commitment type.
 */
function getBlindedCommitmentType (
  commitmentType: number
): BlindedCommitmentType.Shield | BlindedCommitmentType.Transact {
  if (commitmentType === SHIELD_COMMITMENT_TYPE) {
    return BlindedCommitmentType.Shield
  }
  if (commitmentType === TRANSACT_COMMITMENT_TYPE) {
    return BlindedCommitmentType.Transact
  }
  throw new Error(`Unsupported commitment type: ${commitmentType}`)
}

/**
 * Derive a stored note's blinded commitment when it is not yet persisted.
 * @param note - Stored note row with commitment, NPK, and tree position.
 * @returns Derived blinded commitment bytes.
 */
function deriveBlindedCommitment (note: DBNote): Uint8Array {
  if (note.npk === null) {
    throw new Error('Cannot derive blinded commitment without npk')
  }

  return getBlindedCommitmentForShieldOrTransact({
    commitment: note.commitment,
    npk: bytesToBigInt(note.npk),
    globalTreePosition: BigInt(note.treeNumber) * TREE_LEAF_COUNT +
      BigInt(note.treePosition)
  })
}

/**
 * Decide whether a failed batch should be split and retried.
 * @param error - Error thrown while refreshing a batch.
 * @returns True for retryable non-network failures.
 */
function shouldSplitFailure (error: Error): boolean {
  if (error instanceof PoiNodeNetworkError) {
    return false
  }
  if (error instanceof PoiNodeAllUrlsFailedError) {
    return error.errors.length > 0 &&
      error.errors.every(inner => !(inner instanceof PoiNodeNetworkError))
  }
  return true
}

/**
 * Emit a PPOI refresh progress update.
 * @param onProgress - Optional progress callback.
 * @param summary - Current refresh summary counters.
 * @param error - Optional error for failed entries.
 */
function emitPoiProgress (
  onProgress: RefreshOptions['onProgress'],
  summary: RefreshSummary,
  error?: Error
): void {
  onProgress?.({
    phase: SyncPhase.PoiRefresh,
    fromBlock: ZERO_BLOCK,
    toBlock: ZERO_BLOCK,
    currentBlock: ZERO_BLOCK,
    blocksScanned: ZERO_BLOCK,
    notesAdded: 0,
    notesSpent: 0,
    poi: { ...summary },
    ...(error !== undefined && { error })
  })
}

/**
 * Convert thrown values to Error instances.
 * @param error - Thrown value.
 * @returns Error instance.
 */
function toError (error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(String(error))
}

/**
 * Split an array into fixed-size chunks.
 * @param values - Values to split.
 * @param size - Maximum chunk size.
 * @returns Chunked values.
 */
function chunk<T> (values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

export { PoiStatusService }
export type {
  PoiStatusClient,
  PoiStatusServiceOptions,
  RefreshOptions,
  RefreshSummary
}
