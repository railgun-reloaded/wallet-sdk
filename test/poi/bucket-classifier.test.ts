import type { DBNote } from '@railgun-reloaded/storage'
import { test } from 'brittle'

import type { NetworkConfig } from '../../src/network-config'
import { classifyNote, POIStatus, WalletBalanceBucket } from '../../src/poi'

const LIST_A = 'list-a'
const LIST_B = 'list-b'
const CHAIN_ID = 11155111
const SHIELD_COMMITMENT_TYPE = 0
const TRANSACT_COMMITMENT_TYPE = 1
const OUTPUT_TYPE_TRANSFER = 0
const OUTPUT_TYPE_CHANGE = 2

const PPOI_NETWORK: NetworkConfig = {
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

function bytes (value: number): Uint8Array {
  return new Uint8Array(32).fill(value)
}

function noteFixture (overrides: Partial<DBNote> = {}): DBNote {
  return {
    commitment: bytes(1),
    walletId: 'wallet-id',
    chainId: CHAIN_ID,
    nullifier: bytes(2),
    token: '0x0000000000000000000000000000000000000000',
    amount: 1n,
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

test('classifyNote returns Spent before every POI branch', (t) => {
  t.is(
    classifyNote(noteFixture({
      spent: true,
      commitmentType: SHIELD_COMMITMENT_TYPE,
      poisPerList: null
    }), NON_PPOI_NETWORK),
    WalletBalanceBucket.Spent
  )
})

test('classifyNote treats non-PPOI networks as Spendable', (t) => {
  t.is(
    classifyNote(noteFixture({
      commitmentType: SHIELD_COMMITMENT_TYPE,
      poisPerList: null
    }), NON_PPOI_NETWORK),
    WalletBalanceBucket.Spendable
  )
})

test('classifyNote maps missing shield POIs to ShieldPending', (t) => {
  t.is(
    classifyNote(noteFixture({
      commitmentType: SHIELD_COMMITMENT_TYPE,
      poisPerList: null
    }), PPOI_NETWORK),
    WalletBalanceBucket.ShieldPending
  )
})

test('classifyNote maps missing change POIs to MissingInternalPOI', (t) => {
  t.is(
    classifyNote(noteFixture({
      outputType: OUTPUT_TYPE_CHANGE,
      poisPerList: null
    }), PPOI_NETWORK),
    WalletBalanceBucket.MissingInternalPOI
  )
})

test('classifyNote maps missing transfer POIs to MissingExternalPOI', (t) => {
  t.is(
    classifyNote(noteFixture({
      outputType: OUTPUT_TYPE_TRANSFER,
      poisPerList: null
    }), PPOI_NETWORK),
    WalletBalanceBucket.MissingExternalPOI
  )
})

test('classifyNote maps ShieldBlocked required-list status to ShieldBlocked', (t) => {
  t.is(
    classifyNote(noteFixture({
      poisPerList: {
        [LIST_A]: POIStatus.ShieldBlocked,
        [LIST_B]: POIStatus.ProofSubmitted
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.ShieldBlocked
  )
})

test('classifyNote maps non-valid shield POIs to ShieldPending before ProofSubmitted', (t) => {
  t.is(
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

test('classifyNote maps ProofSubmitted required-list status to ProofSubmitted', (t) => {
  t.is(
    classifyNote(noteFixture({
      poisPerList: {
        [LIST_A]: POIStatus.Valid,
        [LIST_B]: POIStatus.ProofSubmitted
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.ProofSubmitted
  )
})

test('classifyNote maps all valid required-list statuses to Spendable', (t) => {
  t.is(
    classifyNote(noteFixture({
      poisPerList: {
        [LIST_A]: POIStatus.Valid,
        [LIST_B]: POIStatus.Valid
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.Spendable
  )
})

test('classifyNote falls back from non-valid change POIs to MissingInternalPOI', (t) => {
  t.is(
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

test('classifyNote falls back from non-valid transfer POIs to MissingExternalPOI', (t) => {
  t.is(
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

test('classifyNote treats missing required-list keys as missing POIs', (t) => {
  t.is(
    classifyNote(noteFixture({
      outputType: OUTPUT_TYPE_CHANGE,
      poisPerList: {
        [LIST_A]: POIStatus.Valid
      }
    }), PPOI_NETWORK),
    WalletBalanceBucket.MissingInternalPOI
  )
})
