enum POIStatus {
  Valid = 'Valid',
  Missing = 'Missing',
  ShieldBlocked = 'ShieldBlocked',
  ProofSubmitted = 'ProofSubmitted'
}

enum WalletBalanceBucket {
  Spendable = 'Spendable',
  ShieldPending = 'ShieldPending',
  ShieldBlocked = 'ShieldBlocked',
  ProofSubmitted = 'ProofSubmitted',
  MissingInternalPOI = 'MissingInternalPOI',
  MissingExternalPOI = 'MissingExternalPOI',
  Spent = 'Spent'
}

/** POI-service classification, separate from protocol spent state. */
type PoiClassification =
  | { kind: 'cleared' }
  | {
    kind: 'pending'
    reason:
      | 'ShieldPending'
      | 'ProofSubmitted'
      | 'MissingInternalPOI'
      | 'MissingExternalPOI'
  }
  | { kind: 'blocked' }

/** Protocol spendability plus the POI tier when the network uses POI. */
type NoteSpendState = {
  /** Protocol-only result derived without consulting POI data. */
  spendable: boolean
  /** POI-service result, or null when POI is not configured for the network. */
  poi: PoiClassification | null
}

enum BlindedCommitmentType {
  Shield = 'Shield',
  Transact = 'Transact',
  Unshield = 'Unshield'
}

enum TXIDVersion {
  V2_PoseidonMerkle = 'V2_PoseidonMerkle',
  V3_PoseidonMerkle = 'V3_PoseidonMerkle'
}

enum POIListType {
  Active = 'Active',
  Gather = 'Gather'
}

type RequiredListKey = string

type POIList = {
  key: RequiredListKey
  type: POIListType
  name: string
  description: string
}

type POIsPerList = {
  [listKey: RequiredListKey]: POIStatus
}

type BlindedCommitmentData = {
  blindedCommitment: string
  type: BlindedCommitmentType
}

export {
  BlindedCommitmentType,
  POIListType,
  POIStatus,
  TXIDVersion,
  WalletBalanceBucket
}
export type {
  BlindedCommitmentData,
  NoteSpendState,
  POIList,
  POIsPerList,
  PoiClassification,
  RequiredListKey
}
