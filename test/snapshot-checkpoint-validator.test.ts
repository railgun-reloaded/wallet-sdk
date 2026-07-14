import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bytesToHex } from '@railgun-reloaded/bytes'

import type {
  SnapshotCheckpointReader
} from '../src/node/index.js'
import {
  COMMITMENT_TREE_CAPACITY,
  ExactSnapshotCheckpointValidator,
  SnapshotCheckpointMismatchError,
  SnapshotCheckpointUnavailableError
} from '../src/node/index.js'

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

type MultiTreeReaderOptions = {
  treeNumber: bigint
  nextLeafIndex: bigint
  latestRoot: Uint8Array
  acceptedHistoricalRoots: Uint8Array[]
}

/**
 * Configurable reader for exercising the multi-tree validation path.
 */
class MultiTreeCheckpointReader implements SnapshotCheckpointReader {
  /** Reader behavior. */
  readonly #options: MultiTreeReaderOptions

  /**
   * Construct a configurable multi-tree reader.
   * @param options - Exact-height contract state to report.
   */
  constructor (options: MultiTreeReaderOptions) {
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
   * Return the configured active tree number.
   * @returns Active tree number.
   */
  async treeNumber (): Promise<bigint> {
    return this.#options.treeNumber
  }

  /**
   * Return the configured next leaf index.
   * @returns Next leaf index.
   */
  async nextLeafIndex (): Promise<bigint> {
    return this.#options.nextLeafIndex
  }

  /**
   * Return the configured latest root.
   * @returns Root hex.
   */
  async merkleRoot (): Promise<string> {
    return bytesToHex(this.#options.latestRoot, { prefix: true })
  }

  /**
   * Accept only the configured set of historical roots.
   * @param _treeNumber - Ignored tree number.
   * @param candidate - Candidate root.
   * @returns Whether the candidate was accepted at the block.
   */
  async hasRoot (_treeNumber: number, candidate: string): Promise<boolean> {
    return this.#options.acceptedHistoricalRoots.some(
      (accepted) => bytesToHex(accepted, { prefix: true }) === candidate
    )
  }
}

test('multi-tree snapshot with a full prior tree validates', async () => {
  const priorRoot = root(1)
  const latestRoot = root(2)
  const validator = new ExactSnapshotCheckpointValidator(
    new MultiTreeCheckpointReader({
      treeNumber: 1n,
      nextLeafIndex: 5n,
      latestRoot,
      acceptedHistoricalRoots: [priorRoot, latestRoot]
    })
  )

  await validator.validate({
    chainID: CHAIN_ID,
    blockHeight: BLOCK_HEIGHT,
    trees: [
      { treeNumber: 0, leafCount: COMMITMENT_TREE_CAPACITY, root: priorRoot },
      { treeNumber: 1, leafCount: 5, root: latestRoot }
    ]
  })
})

test('multi-tree snapshot rejects a prior tree that is not full', async () => {
  const priorRoot = root(1)
  const latestRoot = root(2)
  const validator = new ExactSnapshotCheckpointValidator(
    new MultiTreeCheckpointReader({
      treeNumber: 1n,
      nextLeafIndex: 5n,
      latestRoot,
      acceptedHistoricalRoots: [priorRoot, latestRoot]
    })
  )

  await assert.rejects(
    () => validator.validate({
      chainID: CHAIN_ID,
      blockHeight: BLOCK_HEIGHT,
      trees: [
        { treeNumber: 0, leafCount: COMMITMENT_TREE_CAPACITY - 1, root: priorRoot },
        { treeNumber: 1, leafCount: 5, root: latestRoot }
      ]
    }),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotCheckpointMismatchError)
      assert.match(error.message, /is not full before later tree/)
      return true
    }
  )
})

test('multi-tree snapshot rejects a prior root absent from history', async () => {
  const priorRoot = root(1)
  const latestRoot = root(2)
  const validator = new ExactSnapshotCheckpointValidator(
    new MultiTreeCheckpointReader({
      treeNumber: 1n,
      nextLeafIndex: 5n,
      latestRoot,
      acceptedHistoricalRoots: [latestRoot]
    })
  )

  await assert.rejects(
    () => validator.validate({
      chainID: CHAIN_ID,
      blockHeight: BLOCK_HEIGHT,
      trees: [
        { treeNumber: 0, leafCount: COMMITMENT_TREE_CAPACITY, root: priorRoot },
        { treeNumber: 1, leafCount: 5, root: latestRoot }
      ]
    }),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotCheckpointMismatchError)
      assert.match(error.message, /root is not valid at block/)
      return true
    }
  )
})

test('snapshot tree count mismatch against checkpoint tree number is rejected', async () => {
  const latestRoot = root(2)
  const validator = new ExactSnapshotCheckpointValidator(
    new MultiTreeCheckpointReader({
      treeNumber: 1n,
      nextLeafIndex: 5n,
      latestRoot,
      acceptedHistoricalRoots: [latestRoot]
    })
  )

  await assert.rejects(
    () => validator.validate({
      chainID: CHAIN_ID,
      blockHeight: BLOCK_HEIGHT,
      trees: [
        { treeNumber: 0, leafCount: 5, root: latestRoot }
      ]
    }),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotCheckpointMismatchError)
      assert.match(error.message, /does not match checkpoint tree/)
      return true
    }
  )
})
