import { test } from 'brittle'

import {
  BlindedCommitmentType,
  POIListType,
  POIStatus,
  WalletBalanceBucket
} from '../../src/poi'

test('PPOI enum values match wire fixtures', (t) => {
  t.alike(POIStatus, {
    Valid: 'Valid',
    Missing: 'Missing',
    ShieldBlocked: 'ShieldBlocked',
    ProofSubmitted: 'ProofSubmitted'
  })

  t.alike(WalletBalanceBucket, {
    Spendable: 'Spendable',
    ShieldPending: 'ShieldPending',
    ShieldBlocked: 'ShieldBlocked',
    ProofSubmitted: 'ProofSubmitted',
    MissingInternalPOI: 'MissingInternalPOI',
    MissingExternalPOI: 'MissingExternalPOI',
    Spent: 'Spent'
  })

  t.alike(BlindedCommitmentType, {
    Shield: 'Shield',
    Transact: 'Transact',
    Unshield: 'Unshield'
  })

  t.alike(POIListType, {
    Active: 'Active',
    Gather: 'Gather'
  })
})
