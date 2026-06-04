import type { DBNote } from '@railgun-reloaded/storage'

import type { NetworkConfig as NetworkConfigEntry } from '../network-config'

import { POIStatus, WalletBalanceBucket } from './types'

type POIStatusMap = Record<string, POIStatus | string | undefined>

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
 * @returns Bucket that best describes the missing POI state.
 */
function missingPoiBucket (note: DBNote): WalletBalanceBucket {
  if (isShieldCommitment(note)) {
    return WalletBalanceBucket.ShieldPending
  }
  return isChangeOutput(note)
    ? WalletBalanceBucket.MissingInternalPOI
    : WalletBalanceBucket.MissingExternalPOI
}

/**
 * Classify a note into a wallet balance bucket.
 * @param note - Stored wallet note.
 * @param network - Network config containing required PPOI lists.
 * @returns Balance bucket for spendability and PPOI state.
 */
function classifyNote (
  note: DBNote,
  network: NetworkConfigEntry
): WalletBalanceBucket {
  if (note.spent === true) {
    return WalletBalanceBucket.Spent
  }

  if (network.poi === undefined) {
    throw new Error(`Missing PPOI config for chain ${network.chainID}`)
  }

  if (note.poisPerList == null) {
    return missingPoiBucket(note)
  }

  const poisPerList = note.poisPerList as POIStatusMap
  const requiredListKeys = network.poi.requiredListKeys

  if (!hasAllRequiredLists(poisPerList, requiredListKeys)) {
    return missingPoiBucket(note)
  }

  const requiredStatuses = requiredListKeys.map(key => poisPerList[key])

  if (requiredStatuses.some(status => status === POIStatus.ShieldBlocked)) {
    return WalletBalanceBucket.ShieldBlocked
  }

  if (
    isShieldCommitment(note) &&
    requiredStatuses.some(status => status !== POIStatus.Valid)
  ) {
    return WalletBalanceBucket.ShieldPending
  }

  if (requiredStatuses.some(status => status === POIStatus.ProofSubmitted)) {
    return WalletBalanceBucket.ProofSubmitted
  }

  if (requiredStatuses.every(status => status === POIStatus.Valid)) {
    return WalletBalanceBucket.Spendable
  }

  return isChangeOutput(note)
    ? WalletBalanceBucket.MissingInternalPOI
    : WalletBalanceBucket.MissingExternalPOI
}

export { classifyNote }
