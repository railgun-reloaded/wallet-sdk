import { bytesToBigInt, bytesToHex } from '@railgun-reloaded/bytes'
import type { DBNote, NoteIdentity, NotePoiStatusUpdate, WalletDB } from '@railgun-reloaded/storage'
import {
  getAllNotes,
  updateNotePoiStatusBatch
} from '@railgun-reloaded/storage'

import type { NetworkName } from '../network-config'
import { SyncPhase } from '../sync/wallet-decryptor'
import type { SyncProgress } from '../sync/wallet-decryptor'

import { getBlindedCommitmentForShieldOrTransact } from './blinded-commitment'
import { GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS } from './node-client'
import type { PoiNodeClient } from './node-client'
import {
  PoiNodeAllUrlsFailedError,
  PoiNodeNetworkError
} from './node-client-errors'
import { getRequiredListKeys } from './network-config'
import type { GetPOIsPerListParams } from './node-client-types'
import type { RequiredListKey } from './types'
import { BlindedCommitmentType, POIStatus, TXIDVersion } from './types'

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
  hadStoredBlindedCommitment: boolean
}

const SHIELD_COMMITMENT_TYPE = 0
const TRANSACT_COMMITMENT_TYPE = 1
const TREE_LEAF_COUNT = 65536n
const ZERO_BLOCK = 0n

class PoiStatusService {
  readonly #walletDb: WalletDB
  readonly #poiNodeClient: PoiStatusClient
  readonly #network: NetworkName
  readonly #listKeys: RequiredListKey[]
  readonly #txidVersion: TXIDVersion

  constructor (options: PoiStatusServiceOptions) {
    this.#walletDb = options.walletDb
    this.#poiNodeClient = options.poiNodeClient
    this.#network = options.network
    this.#listKeys = options.listKeys ?? getRequiredListKeys(options.network)
    this.#txidVersion = options.txidVersion ?? TXIDVersion.V2_PoseidonMerkle
  }

  async refresh (
    walletId: string,
    chainId: number,
    options: RefreshOptions = {}
  ): Promise<RefreshSummary> {
    const candidates = getAllNotes(this.#walletDb, walletId, chainId)
      .filter(note => shouldRefreshPoiStatus(note, this.#listKeys))
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
      } catch {
        summary.skipped += 1
      }
    }

    const blindedOnlyUpdates = entries
      .filter(entry => !entry.hadStoredBlindedCommitment)
      .map(entry => ({
        walletId: entry.walletId,
        chainId: entry.chainId,
        commitment: entry.commitment,
        blindedCommitment: entry.blindedCommitment,
        poisPerList: null
      }))

    updateNotePoiStatusBatch(this.#walletDb, blindedOnlyUpdates)

    if (this.#listKeys.length === 0) {
      summary.skipped += entries.length
      emitPoiProgress(options.onProgress, summary)
      return summary
    }

    for (const batch of chunk(entries, GET_POI_EXISTENCE_MAX_BLINDED_COMMITMENTS)) {
      await this.#refreshEntries(batch, summary, options.onProgress)
    }

    // T5 sent_commitments / unshield_poi_status refresh is deferred for the demo path.
    emitPoiProgress(options.onProgress, summary)
    return summary
  }

  async #refreshEntries (
    entries: RefreshEntry[],
    summary: RefreshSummary,
    onProgress: RefreshOptions['onProgress']
  ): Promise<void> {
    if (entries.length === 0) return

    try {
      const response = await this.#poiNodeClient.getPOIsPerList({
        network: this.#network,
        txidVersion: this.#txidVersion,
        listKeys: this.#listKeys,
        blindedCommitmentDatas: entries.map(entry => ({
          blindedCommitment: entry.blindedCommitmentHex,
          type: entry.type
        }))
      } satisfies GetPOIsPerListParams)

      const updates: NotePoiStatusUpdate[] = []
      for (const entry of entries) {
        const poisPerList = response[entry.blindedCommitmentHex]
        if (poisPerList === undefined) {
          summary.skipped += 1
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

      summary.updated += updateNotePoiStatusBatch(this.#walletDb, updates)
      emitPoiProgress(onProgress, summary)
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
    }
  }
}

function shouldRefreshPoiStatus (
  note: DBNote,
  listKeys: RequiredListKey[]
): boolean {
  if (note.poisPerList == null) {
    return true
  }
  if (listKeys.length === 0) {
    return false
  }

  const poisPerList = note.poisPerList as Record<string, string | undefined>
  return listKeys.some(key => poisPerList[key] !== POIStatus.Valid)
}

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
    type,
    hadStoredBlindedCommitment: note.blindedCommitment !== null
  }
}

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

function toError (error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(String(error))
}

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
