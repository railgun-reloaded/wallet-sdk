import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DBNote } from '@railgun-reloaded/storage'

import type { NetworkConfig } from '../../src/network-config'
import type {
  NoteSpendState,
  PoiClassification
} from '../../src/poi'
import {
  POIStatus,
  WalletBalanceBucket,
  classifyNote,
  classifyNoteSpendState,
  classifyPoi,
  isSpendableProtocol,
  toWalletBalanceBucket
} from '../../src/poi'
import type { PoiNetworkConfig } from '../../src/poi/bucket-classifier'

const LIST_A = 'list-a'
const LIST_B = 'list-b'
const CHAIN_ID = 11155111
const SHIELD_COMMITMENT_TYPE = 0
const TRANSACT_COMMITMENT_TYPE = 1
const OUTPUT_TYPE_TRANSFER = 0
const OUTPUT_TYPE_CHANGE = 2

const PPOI_NETWORK: PoiNetworkConfig = {
  chainID: CHAIN_ID,
  deploymentBlock: 1n,
  proxyContractAddress: '0x0000000000000000000000000000000000000000',
  rpcURL: 'https://rpc.example',
  poi: {
    launchBlock: 1n,
    launchTimestamp: 0,
    requiredListKeys: [LIST_A, LIST_B]
  }
}

const NON_PPOI_NETWORK: NetworkConfig = {
  chainID: 1,
  deploymentBlock: 1n,
  proxyContractAddress: '0x0000000000000000000000000000000000000000',
  rpcURL: 'https://rpc.example'
}

/**
 * Create deterministic 32-byte fixture data.
 * @param value - Byte value to repeat.
 * @returns Fixture bytes.
 */
function bytes (value: number): Uint8Array {
  return new Uint8Array(32).fill(value)
}

/**
 * Create a note fixture for bucket classification tests.
 * @param overrides - Optional note fields to override.
 * @returns Stored note row.
 */
function noteFixture (overrides: Partial<DBNote> = {}): DBNote {
  return {
    commitment: bytes(1),
    walletId: 'wallet-id',
    chainId: CHAIN_ID,
    nullifier: bytes(2),
    token: '0x0000000000000000000000000000000000000000',
    amount: 1n,
    tokenType: 0,
    tokenSubID: new Uint8Array(32),
    spent: false,
    spentTxid: null,
    blockNumber: 1n,
    treeNumber: 0,
    treePosition: 0,
    commitmentType: TRANSACT_COMMITMENT_TYPE,
    outputType: OUTPUT_TYPE_TRANSFER,
    npk: null,
    random: null,
    blindedCommitment: null,
    creationRailgunTxid: null,
    creationTxid: null,
    poisPerList: {
      [LIST_A]: POIStatus.Valid,
      [LIST_B]: POIStatus.Valid
    },
    decryptedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  }
}

test('isSpendableProtocol depends only on protocol spent state', () => {
  assert.equal(
    isSpendableProtocol(noteFixture({
      spent: false,
      poisPerList: {
        [LIST_A]: POIStatus.ShieldBlocked,
        [LIST_B]: POIStatus.ShieldBlocked
      }
    })),
    true
  )
  assert.equal(
    isSpendableProtocol(noteFixture({
      spent: true,
      poisPerList: {
        [LIST_A]: POIStatus.Valid,
        [LIST_B]: POIStatus.Valid
      }
    })),
    false
  )
})

test('classifyPoi returns only the POI service tier', () => {
  const cases: Array<{
    note: DBNote
    expected: PoiClassification
  }> = [
    {
      note: noteFixture({
        commitmentType: SHIELD_COMMITMENT_TYPE,
        poisPerList: null
      }),
      expected: { kind: 'pending', reason: 'ShieldPending' }
    },
    {
      note: noteFixture({
        outputType: OUTPUT_TYPE_CHANGE,
        poisPerList: null
      }),
      expected: { kind: 'pending', reason: 'MissingInternalPOI' }
    },
    {
      note: noteFixture({
        outputType: OUTPUT_TYPE_TRANSFER,
        poisPerList: null
      }),
      expected: { kind: 'pending', reason: 'MissingExternalPOI' }
    },
    {
      note: noteFixture({
        spent: true,
        poisPerList: {
          [LIST_A]: POIStatus.ShieldBlocked,
          [LIST_B]: POIStatus.ProofSubmitted
        }
      }),
      expected: { kind: 'blocked' }
    },
    {
      note: noteFixture({
        commitmentType: SHIELD_COMMITMENT_TYPE,
        poisPerList: {
          [LIST_A]: POIStatus.Valid,
          [LIST_B]: POIStatus.ProofSubmitted
        }
      }),
      expected: { kind: 'pending', reason: 'ShieldPending' }
    },
    {
      note: noteFixture({
        poisPerList: {
          [LIST_A]: POIStatus.Valid,
          [LIST_B]: POIStatus.ProofSubmitted
        }
      }),
      expected: { kind: 'pending', reason: 'ProofSubmitted' }
    },
    {
      note: noteFixture(),
      expected: { kind: 'cleared' }
    },
    {
      note: noteFixture({
        outputType: OUTPUT_TYPE_CHANGE,
        poisPerList: {
          [LIST_A]: POIStatus.Valid
        }
      }),
      expected: { kind: 'pending', reason: 'MissingInternalPOI' }
    }
  ]

  for (const { note, expected } of cases) {
    assert.deepEqual(classifyPoi(note, PPOI_NETWORK.poi), expected)
  }
})

test('classifyNoteSpendState models non-PPOI networks with an absent POI tier', () => {
  assert.deepEqual(
    classifyNoteSpendState(noteFixture({
      commitmentType: SHIELD_COMMITMENT_TYPE,
      poisPerList: null
    }), NON_PPOI_NETWORK),
    {
      spendable: true,
      poi: null
    }
  )
  assert.deepEqual(
    classifyNoteSpendState(noteFixture({
      spent: true,
      poisPerList: {
        [LIST_A]: POIStatus.ShieldBlocked,
        [LIST_B]: POIStatus.ShieldBlocked
      }
    }), NON_PPOI_NETWORK),
    {
      spendable: false,
      poi: null
    }
  )
})

test('toWalletBalanceBucket preserves every flat wire value and precedence', () => {
  assert.deepEqual(Object.values(WalletBalanceBucket), [
    'Spendable',
    'ShieldPending',
    'ShieldBlocked',
    'ProofSubmitted',
    'MissingInternalPOI',
    'MissingExternalPOI',
    'Spent'
  ])

  const cases: Array<{
    state: NoteSpendState
    expected: WalletBalanceBucket
  }> = [
    {
      state: { spendable: false, poi: { kind: 'blocked' } },
      expected: WalletBalanceBucket.Spent
    },
    {
      state: { spendable: true, poi: { kind: 'blocked' } },
      expected: WalletBalanceBucket.ShieldBlocked
    },
    {
      state: {
        spendable: true,
        poi: { kind: 'pending', reason: 'ShieldPending' }
      },
      expected: WalletBalanceBucket.ShieldPending
    },
    {
      state: {
        spendable: true,
        poi: { kind: 'pending', reason: 'ProofSubmitted' }
      },
      expected: WalletBalanceBucket.ProofSubmitted
    },
    {
      state: {
        spendable: true,
        poi: { kind: 'pending', reason: 'MissingInternalPOI' }
      },
      expected: WalletBalanceBucket.MissingInternalPOI
    },
    {
      state: {
        spendable: true,
        poi: { kind: 'pending', reason: 'MissingExternalPOI' }
      },
      expected: WalletBalanceBucket.MissingExternalPOI
    },
    {
      state: { spendable: true, poi: { kind: 'cleared' } },
      expected: WalletBalanceBucket.Spendable
    },
    {
      state: { spendable: true, poi: null },
      expected: WalletBalanceBucket.Spendable
    }
  ]

  for (const { state, expected } of cases) {
    assert.equal(toWalletBalanceBucket(state), expected)
  }
})

test('classifyNote returns Spent before every POI branch', () => {
  assert.equal(
    classifyNote(noteFixture({
      spent: true,
      commitmentType: SHIELD_COMMITMENT_TYPE,
      poisPerList: null
    }), PPOI_NETWORK),
    WalletBalanceBucket.Spent
  )
})

test('classifyNote maps non-PPOI unspent notes to Spendable', () => {
  assert.equal(
    classifyNote(noteFixture({
      commitmentType: SHIELD_COMMITMENT_TYPE,
      poisPerList: null
    }), NON_PPOI_NETWORK),
    WalletBalanceBucket.Spendable
  )
})

test('classifyNote maps missing shield POIs to ShieldPending', () => {
  assert.equal(
    classifyNote(noteFixture({
      commitmentType: SHIELD_COMMITMENT_TYPE,
      poisPerList: null
    }), PPOI_NETWORK),
    WalletBalanceBucket.ShieldPending
  )
})

test('classifyNote maps missing change POIs to MissingInternalPOI', () => {
  assert.equal(
    classifyNote(noteFixture({
      outputType: OUTPUT_TYPE_CHANGE,
      poisPerList: null
    }), PPOI_NETWORK),
    WalletBalanceBucket.MissingInternalPOI
  )
})

test('classifyNote maps missing transfer POIs to MissingExternalPOI', () => {
  assert.equal(
    classifyNote(noteFixture({
      outputType: OUTPUT_TYPE_TRANSFER,
      poisPerList: null
    }), PPOI_NETWORK),
    WalletBalanceBucket.MissingExternalPOI
  )
})

test('classifyNote maps ShieldBlocked required-list status to ShieldBlocked', () => {
  assert.equal(
    classifyNote(noteFixture({
      poisPerList: {
        [LIST_A]: POIStatus.ShieldBlocked,
        [LIST_B]: POIStatus.ProofSubmitted
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.ShieldBlocked
  )
})

test('classifyNote maps non-valid shield POIs to ShieldPending before ProofSubmitted', () => {
  assert.equal(
    classifyNote(noteFixture({
      commitmentType: SHIELD_COMMITMENT_TYPE,
      poisPerList: {
        [LIST_A]: POIStatus.Valid,
        [LIST_B]: POIStatus.ProofSubmitted
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.ShieldPending
  )
})

test('classifyNote maps ProofSubmitted required-list status to ProofSubmitted', () => {
  assert.equal(
    classifyNote(noteFixture({
      poisPerList: {
        [LIST_A]: POIStatus.Valid,
        [LIST_B]: POIStatus.ProofSubmitted
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.ProofSubmitted
  )
})

test('classifyNote maps all valid required-list statuses to Spendable', () => {
  assert.equal(
    classifyNote(noteFixture({
      poisPerList: {
        [LIST_A]: POIStatus.Valid,
        [LIST_B]: POIStatus.Valid
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.Spendable
  )
})

test('classifyNote falls back from non-valid change POIs to MissingInternalPOI', () => {
  assert.equal(
    classifyNote(noteFixture({
      outputType: OUTPUT_TYPE_CHANGE,
      poisPerList: {
        [LIST_A]: POIStatus.Valid,
        [LIST_B]: POIStatus.Missing
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.MissingInternalPOI
  )
})

test('classifyNote falls back from non-valid transfer POIs to MissingExternalPOI', () => {
  assert.equal(
    classifyNote(noteFixture({
      outputType: OUTPUT_TYPE_TRANSFER,
      poisPerList: {
        [LIST_A]: POIStatus.Valid,
        [LIST_B]: POIStatus.Missing
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.MissingExternalPOI
  )
})

test('classifyNote treats missing required-list keys as missing POIs', () => {
  assert.equal(
    classifyNote(noteFixture({
      outputType: OUTPUT_TYPE_CHANGE,
      poisPerList: {
        [LIST_A]: POIStatus.Valid
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.MissingInternalPOI
  )
})
