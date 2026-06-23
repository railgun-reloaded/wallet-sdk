import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bytesToHex } from '@railgun-reloaded/bytes'

import type {
  SnapshotCheckpointReader
} from '../src/snapshot-bootstrap/checkpoint-validator.js'
import {
  ExactSnapshotCheckpointValidator,
  SnapshotCheckpointMismatchError,
  SnapshotCheckpointUnavailableError
} from '../src/snapshot-bootstrap/checkpoint-validator.js'

const CHAIN_ID = 11155111
const BLOCK_HEIGHT = 6_000_000n

/**
 * Build a deterministic root.
 * @param value - Fill byte.
 * @returns 32-byte root.
 */
function root (value: number): Uint8Array {
  return new Uint8Array(32).fill(value)
}

type TestCheckpointReaderOptions = {
  historicalRootsAlwaysValid?: boolean
  treeNumberError?: Error
}

/**
 * Deterministic exact-height checkpoint reader for validator tests.
 */
class TestCheckpointReader implements SnapshotCheckpointReader {
  /** Reader behavior overrides. */
  readonly #options: TestCheckpointReaderOptions
  /** Expected root returned by exact-height reads. */
  readonly #expectedRoot = bytesToHex(root(7), { prefix: true })

  /**
   * Construct a deterministic reader.
   * @param options - Optional behavior overrides.
   */
  constructor (options: TestCheckpointReaderOptions = {}) {
    this.#options = options
  }

  /**
   * Return the configured chain.
   * @returns Chain ID.
   */
  async chainID (): Promise<bigint> {
    return BigInt(CHAIN_ID)
  }

  /**
   * Return tree zero or throw the configured archive error.
   * @returns Active tree number.
   */
  async treeNumber (): Promise<bigint> {
    if (this.#options.treeNumberError) {
      throw this.#options.treeNumberError
    }
    return 0n
  }

  /**
   * Return the exact next leaf index.
   * @returns Next leaf index.
   */
  async nextLeafIndex (): Promise<bigint> {
    return 2n
  }

  /**
   * Return the exact latest root.
   * @returns Root hex.
   */
  async merkleRoot (): Promise<string> {
    return this.#expectedRoot
  }

  /**
   * Check historical-root membership.
   * @param _treeNumber - Ignored tree number.
   * @param candidate - Candidate root.
   * @returns Whether the candidate is accepted.
   */
  async hasRoot (_treeNumber: number, candidate: string): Promise<boolean> {
    return this.#options.historicalRootsAlwaysValid === true ||
      candidate === this.#expectedRoot
  }
}

test('exact checkpoint validator accepts matching root and leaf position', async () => {
  const validator = new ExactSnapshotCheckpointValidator(
    new TestCheckpointReader()
  )
  await validator.validate({
    chainID: CHAIN_ID,
    blockHeight: BLOCK_HEIGHT,
    trees: [{
      treeNumber: 0,
      leafCount: 2,
      root: root(7)
    }]
  })
})

test('historically valid stale root does not pass the exact checkpoint', async () => {
  const staleRoot = root(3)
  const validator = new ExactSnapshotCheckpointValidator(
    new TestCheckpointReader({ historicalRootsAlwaysValid: true })
  )

  await assert.rejects(
    () => validator.validate({
      chainID: CHAIN_ID,
      blockHeight: BLOCK_HEIGHT,
      trees: [{
        treeNumber: 0,
        leafCount: 2,
        root: staleRoot
      }]
    }),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotCheckpointMismatchError)
      assert.match(error.message, /does not match checkpoint root/)
      return true
    }
  )
})

test('checkpoint validator rejects leaf-position mismatch', async () => {
  const validator = new ExactSnapshotCheckpointValidator(
    new TestCheckpointReader()
  )
  await assert.rejects(
    () => validator.validate({
      chainID: CHAIN_ID,
      blockHeight: BLOCK_HEIGHT,
      trees: [{
        treeNumber: 0,
        leafCount: 1,
        root: root(7)
      }]
    }),
    /does not match checkpoint next leaf/
  )
})

test('checkpoint read failure is surfaced as unavailable exact-height state', async () => {
  const validator = new ExactSnapshotCheckpointValidator(
    new TestCheckpointReader({
      treeNumberError: new Error('archive state unavailable')
    })
  )

  await assert.rejects(
    () => validator.validate({
      chainID: CHAIN_ID,
      blockHeight: BLOCK_HEIGHT,
      trees: [{
        treeNumber: 0,
        leafCount: 2,
        root: root(7)
      }]
    }),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotCheckpointUnavailableError)
      assert.match(error.message, new RegExp(BLOCK_HEIGHT.toString()))
      return true
    }
  )
})
