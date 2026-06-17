import type { DBNote } from '@railgun-reloaded/storage'

import type { NetworkConfig as NetworkConfigEntry } from '../network-config'

import type { NetworkPoiConfig } from './network-config'
import type { NoteSpendState, PoiClassification } from './types'
import { POIStatus, WalletBalanceBucket } from './types'

type POIStatusMap = Record<string, POIStatus | string | undefined>
type PoiNetworkConfig = NetworkConfigEntry & {
  poi: NonNullable<NetworkConfigEntry['poi']>
}

const SHIELD_COMMITMENT_TYPE = 0
const OUTPUT_TYPE_CHANGE = 2

/**
 * Check whether a note came from a shield commitment.
 * @param note - Stored wallet note.
 * @returns True for shield commitments.
 */
function isShieldCommitment (note: DBNote): boolean {
  return note.commitmentType === SHIELD_COMMITMENT_TYPE
}

/**
 * Check whether a transact output is internal change.
 * @param note - Stored wallet note.
 * @returns True for change outputs.
 */
function isChangeOutput (note: DBNote): boolean {
  return note.outputType === OUTPUT_TYPE_CHANGE
}

/**
 * Check whether the POI map contains every required list key.
 * @param poisPerList - POI statuses keyed by list.
 * @param requiredListKeys - List keys required by the network.
 * @returns True when every required key is present.
 */
function hasAllRequiredLists (
  poisPerList: POIStatusMap,
  requiredListKeys: string[]
): boolean {
  return requiredListKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(poisPerList, key)
  )
}

/**
 * Classify a note whose required POI data is missing or incomplete.
 * @param note - Stored wallet note.
 * @returns Pending POI classification for the note structure.
 */
function missingPoiClassification (note: DBNote): PoiClassification {
  if (isShieldCommitment(note)) {
    return { kind: 'pending', reason: 'ShieldPending' }
  }
  return {
    kind: 'pending',
    reason: isChangeOutput(note)
      ? 'MissingInternalPOI'
      : 'MissingExternalPOI'
  }
}

/**
 * Resolve protocol-level note spendability without consulting POI state.
 * @param note - Stored wallet note.
 * @returns True when the note has not been spent.
 */
function isSpendableProtocol (note: DBNote): boolean {
  return note.spent !== true
}

/**
 * Classify only the POI tier of a note.
 * @param note - Stored wallet note.
 * @param poiNetwork - Network POI config containing required list keys.
 * @returns POI service classification, independent of spent state.
 */
function classifyPoi (
  note: DBNote,
  poiNetwork: NetworkPoiConfig
): PoiClassification {
  if (note.poisPerList == null) {
    return missingPoiClassification(note)
  }

  const poisPerList = note.poisPerList as POIStatusMap
  const requiredListKeys = poiNetwork.requiredListKeys

  if (!hasAllRequiredLists(poisPerList, requiredListKeys)) {
    return missingPoiClassification(note)
  }

  const requiredStatuses = requiredListKeys.map(key => poisPerList[key])

  if (requiredStatuses.some(status => status === POIStatus.ShieldBlocked)) {
    return { kind: 'blocked' }
  }

  if (
    isShieldCommitment(note) &&
    requiredStatuses.some(status => status !== POIStatus.Valid)
  ) {
    return { kind: 'pending', reason: 'ShieldPending' }
  }

  if (requiredStatuses.some(status => status === POIStatus.ProofSubmitted)) {
    return { kind: 'pending', reason: 'ProofSubmitted' }
  }

  if (requiredStatuses.every(status => status === POIStatus.Valid)) {
    return { kind: 'cleared' }
  }

  return {
    kind: 'pending',
    reason: isChangeOutput(note)
      ? 'MissingInternalPOI'
      : 'MissingExternalPOI'
  }
}

/**
 * Classify a note into the legible two-tier spend state.
 * @param note - Stored wallet note.
 * @param network - Network config, with optional POI config.
 * @returns Protocol spendability with optional POI service classification.
 */
function classifyNoteSpendState (
  note: DBNote,
  network: NetworkConfigEntry
): NoteSpendState {
  return {
    spendable: isSpendableProtocol(note),
    poi: network.poi === undefined
      ? null
      : classifyPoi(note, network.poi)
  }
}

/**
 * Project the two-tier note state to the parity-critical flat bucket.
 * @param state - Protocol spendability and optional POI classification.
 * @returns Flat wallet balance bucket.
 */
function toWalletBalanceBucket (
  state: NoteSpendState
): WalletBalanceBucket {
  if (!state.spendable) {
    return WalletBalanceBucket.Spent
  }

  if (state.poi === null || state.poi.kind === 'cleared') {
    return WalletBalanceBucket.Spendable
  }

  if (state.poi.kind === 'blocked') {
    return WalletBalanceBucket.ShieldBlocked
  }

  switch (state.poi.reason) {
    case 'ShieldPending':
      return WalletBalanceBucket.ShieldPending
    case 'ProofSubmitted':
      return WalletBalanceBucket.ProofSubmitted
    case 'MissingInternalPOI':
      return WalletBalanceBucket.MissingInternalPOI
    case 'MissingExternalPOI':
      return WalletBalanceBucket.MissingExternalPOI
  }
}

/**
 * Classify a note into the parity-critical flat wallet balance bucket.
 * @param note - Stored wallet note.
 * @param network - Network config, with optional POI config.
 * @returns Balance bucket for spendability and PPOI state.
 */
function classifyNote (
  note: DBNote,
  network: NetworkConfigEntry
): WalletBalanceBucket {
  return toWalletBalanceBucket(classifyNoteSpendState(note, network))
}

export {
  classifyNote,
  classifyNoteSpendState,
  classifyPoi,
  isSpendableProtocol,
  toWalletBalanceBucket
}
export type { PoiNetworkConfig }
