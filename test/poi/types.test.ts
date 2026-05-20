import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BlindedCommitmentType,
  POIListType,
  POIStatus,
  WalletBalanceBucket
} from '../../src/poi'

test('PPOI enum values match wire fixtures', () => {
  assert.deepEqual(POIStatus, {
    Valid: 'Valid',
    Missing: 'Missing',
    ShieldBlocked: 'ShieldBlocked',
    ProofSubmitted: 'ProofSubmitted'
  })

  assert.deepEqual(WalletBalanceBucket, {
    Spendable: 'Spendable',
    ShieldPending: 'ShieldPending',
    ShieldBlocked: 'ShieldBlocked',
    ProofSubmitted: 'ProofSubmitted',
    MissingInternalPOI: 'MissingInternalPOI',
    MissingExternalPOI: 'MissingExternalPOI',
    Spent: 'Spent'
  })

  assert.deepEqual(BlindedCommitmentType, {
    Shield: 'Shield',
    Transact: 'Transact',
    Unshield: 'Unshield'
  })

  assert.deepEqual(POIListType, {
    Active: 'Active',
    Gather: 'Gather'
  })
})
