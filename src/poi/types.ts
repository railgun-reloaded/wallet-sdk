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
  POIList,
  POIsPerList,
  RequiredListKey
}
