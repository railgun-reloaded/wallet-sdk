import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DBNote } from '@railgun-reloaded/storage'

import {
  NetworkName,
  POIStatus,
  PoiNodeUrlsRequiredError,
  PoiStatusRefreshError,
  WalletBalanceBucket,
  classifyNote,
  classifyNoteSpendState,
  generateWalletId,
  isSpendableProtocol,
  toWalletBalanceBucket
} from '../src/browser/index.js'
import type { NetworkConfig } from '../src/network-config.js'
import { generateWalletId as generateWalletIdFromNode } from '../src/node/index.js'

import { MNEMONIC, VECTORS } from './fixtures/wallet-vectors.js'

const LIST_KEY = 'list-a'
const CHAIN_ID = 11155111
const SHIELD_COMMITMENT_TYPE = 0

const PPOI_NETWORK: NetworkConfig = {
  chainID: CHAIN_ID,
  deploymentBlock: 1n,
  proxyContractAddress: '0x0000000000000000000000000000000000000000',
  rpcURL: 'https://rpc.example',
  poi: {
    launchBlock: 1n,
    launchTimestamp: 0,
    requiredListKeys: [LIST_KEY]
  }
}

/**
 * Create a note fixture for classification through the browser entry.
 * @param overrides - Optional note fields to override.
 * @returns Stored note row.
 */
function noteFixture (overrides: Partial<DBNote> = {}): DBNote {
  return {
    commitment: new Uint8Array(32).fill(1),
    walletId: 'wallet-id',
    chainId: CHAIN_ID,
    nullifier: new Uint8Array(32).fill(2),
    token: '0x0000000000000000000000000000000000000000',
    amount: 1n,
    tokenType: 0,
    tokenSubID: new Uint8Array(32),
    spent: false,
    spentTxid: null,
    spentBlockNumber: null,
    spentTimestamp: null,
    blockNumber: 1n,
    treeNumber: 0,
    treePosition: 0,
    commitmentType: 1,
    outputType: 0,
    npk: null,
    random: null,
    blindedCommitment: null,
    creationRailgunTxid: null,
    creationTxid: null,
    poisPerList: { [LIST_KEY]: POIStatus.Valid },
    decryptedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  }
}

test('classifyNoteSpendState projects to a bucket through the browser entry', () => {
  const state = classifyNoteSpendState(noteFixture(), PPOI_NETWORK)

  assert.equal(state.spendable, true)
  assert.deepEqual(state.poi, { kind: 'cleared' })
  assert.equal(toWalletBalanceBucket(state), WalletBalanceBucket.Spendable)
})

test('a spent note buckets as Spent regardless of POI state', () => {
  const state = classifyNoteSpendState(
    noteFixture({ spent: true }),
    PPOI_NETWORK
  )

  assert.equal(isSpendableProtocol(noteFixture({ spent: true })), false)
  assert.equal(toWalletBalanceBucket(state), WalletBalanceBucket.Spent)
})

test('an unproven shield buckets as ShieldPending', () => {
  const note = noteFixture({
    commitmentType: SHIELD_COMMITMENT_TYPE,
    poisPerList: { [LIST_KEY]: POIStatus.Missing }
  })

  assert.equal(classifyNote(note, PPOI_NETWORK), WalletBalanceBucket.ShieldPending)
})

test('classifyNote agrees with the two-step projection', () => {
  const note = noteFixture()

  assert.equal(
    classifyNote(note, PPOI_NETWORK),
    toWalletBalanceBucket(classifyNoteSpendState(note, PPOI_NETWORK))
  )
})

test('POI errors are narrowable by class from the browser entry', () => {
  const missingUrls: unknown = new PoiNodeUrlsRequiredError(NetworkName.EthereumSepolia)
  const refreshFailed: unknown = new PoiStatusRefreshError({
    code: 'MissingStatusResponse',
    walletId: 'wallet-id',
    chainId: CHAIN_ID,
    message: 'no status returned'
  })

  assert.ok(missingUrls instanceof PoiNodeUrlsRequiredError)
  assert.ok(missingUrls instanceof Error)
  assert.ok(!(missingUrls instanceof PoiStatusRefreshError))

  assert.ok(refreshFailed instanceof PoiStatusRefreshError)
  assert.equal((refreshFailed as PoiStatusRefreshError).code, 'MissingStatusResponse')
})

test('generateWalletId is the same function on the portable and node entries', () => {
  assert.equal(generateWalletId(MNEMONIC, 0), VECTORS[0]!.walletId)
  assert.equal(generateWalletId(MNEMONIC, 0), generateWalletIdFromNode(MNEMONIC, 0))
})
