import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EVMBlock } from '@railgun-reloaded/scanner'
import { SourceAggregator } from '@railgun-reloaded/scanner'

import type {
  DecryptParams,
  ScanParams
} from '../src/client'
import { NetworkName } from '../src/network-config'
import type { BalanceSyncSchedulerClient } from '../src/services/balance/balance-sync-scheduler'
import {
  BalanceSyncScheduler,
  BalanceSyncSchedulerStoppedError
} from '../src/services/balance/balance-sync-scheduler'
import type { DecryptSummary } from '../src/sync/wallet-decryptor'

const KEY_A = new Uint8Array(32).fill(1)
const KEY_B = new Uint8Array(32).fill(2)

/**
 * Minimal DataSource fake that yields nothing; the scheduler only needs a
 * non-live source so the aggregator drains immediately to head.
 */
class EmptySource {
  /** Required by DataSource — non-live so the aggregator drains to its head. */
  isLiveProvider = false

  /**
   * Last block this source can serve.
   * @returns Always 0n since the source is empty.
   */
  async head () {
    return 0n
  }

  /**
   * Yield no blocks.
   */
  async * from (): AsyncGenerator<EVMBlock> {}

  /** No-op for the fake; required by the DataSource shape. */
  destroy () {}
}

/**
 * In-memory BalanceSyncSchedulerClient fake that records scan/decrypt calls
 * and lets each test override behaviour via `scanImpl` / `decryptImpl`.
 */
class FakeClient implements BalanceSyncSchedulerClient {
  /** Every scan() invocation's params, in call order. */
  readonly scanCalls: ScanParams[] = []
  /** Every decrypt() invocation's arguments, in call order. */
  readonly decryptCalls: Array<{
    walletId: string
    encryptionKey: Uint8Array
    params: DecryptParams
  }> = []

  /** Optional override for scan(); receives params and a 1-based call number. */
  scanImpl: (
    (params: ScanParams, callNumber: number) => Promise<bigint | undefined>
  ) | undefined

  /** Optional override for decrypt(). */
  decryptImpl: (
    (
      walletId: string,
      encryptionKey: Uint8Array,
      params: DecryptParams
    ) => Promise<DecryptSummary>
  ) | undefined

  /**
   * Record a scan and delegate to `scanImpl` when set.
   * @param params - Scan parameters from the scheduler.
   * @returns The scanned-to block; defaults to `params.endBlock`.
   */
  async scan (params: ScanParams): Promise<bigint | undefined> {
    this.scanCalls.push(params)
    const callNumber = this.scanCalls.length
    if (this.scanImpl) {
      return this.scanImpl(params, callNumber)
    }
    return params.endBlock
  }

  /**
   * Record a decrypt and delegate to `decryptImpl` when set.
   * @param walletId - Wallet being decrypted.
   * @param encryptionKey - Wallet encryption key.
   * @param params - Decrypt parameters from the scheduler.
   * @returns A decrypt summary with zeroed counters by default.
   */
  async decrypt (
    walletId: string,
    encryptionKey: Uint8Array,
    params: DecryptParams
  ): Promise<DecryptSummary> {
    this.decryptCalls.push({ walletId, encryptionKey, params })
    if (this.decryptImpl) {
      return this.decryptImpl(walletId, encryptionKey, params)
    }
    return {
      walletId,
      chainId: params.chainId,
      fromBlock: params.fromBlock ?? 0n,
      toBlock: params.toBlock ?? 0n,
      blocksScanned: 0n,
      notesAdded: 0,
      notesSpent: 0
    }
  }
}

/**
 * Build a SourceAggregator backed by a single empty source.
 * @returns Aggregator suitable for the scheduler's dataSourceFactory.
 */
function dataSource () {
  return new SourceAggregator<EVMBlock>([new EmptySource()])
}

/**
 * Create an externally-resolvable promise for sequencing async test steps.
 * @returns The promise plus its resolve/reject functions.
 */
function deferred<T> () {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void
  let rejectDeferred!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return {
    promise,
    resolve: resolveDeferred,
    reject: rejectDeferred
  }
}
/**
 * Resolve after a delay.
 * @param ms - Milliseconds to wait.
 * @returns A promise that resolves once the delay elapses.
 */
function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Poll a predicate until it is true or the timeout elapses.
 * @param predicate - Condition to wait for.
 * @param timeoutMs - Maximum time to wait before failing the test.
 * @returns A promise that resolves once the predicate holds.
 */
async function waitFor (
  predicate: () => boolean,
  timeoutMs = 200
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(1)
  }
  assert.fail('timed out waiting for condition')
}

test('requestRefresh coalesces concurrent calls and scans once for many wallets', async () => {
  const client = new FakeClient()
  const scheduler = new BalanceSyncScheduler({
    client,
    network: NetworkName.EthereumSepolia,
    wallets: [
      { walletId: 'wallet-a', encryptionKey: KEY_A },
      { walletId: 'wallet-b', encryptionKey: KEY_B }
    ],
    dataSourceFactory: dataSource,
    /**
     * Report the raw chain head to the scheduler.
     * @returns Fixed raw chain head.
     */
    getHead: () => 120n,
    confirmations: 5n
  })

  const first = scheduler.requestRefresh()
  const second = scheduler.requestRefresh()
  await Promise.all([first, second])

  assert.equal(client.scanCalls.length, 1, 'one scan pass ran')
  assert.equal(client.scanCalls[0]!.endBlock, 115n, 'scan used confirmed target')
  assert.deepEqual(
    client.decryptCalls.map(call => call.walletId),
    ['wallet-a', 'wallet-b'],
    'each wallet decrypted after the shared scan'
  )
  assert.ok(
    client.decryptCalls.every(call => call.params.toBlock === 115n),
    'decrypt calls used the same confirmed target'
  )

  scheduler.stop()
})

test('post-tx refresh waits until confirmed target covers afterBlock', async () => {
  const client = new FakeClient()
  let head = 104n
  const scheduler = new BalanceSyncScheduler({
    client,
    network: NetworkName.EthereumSepolia,
    wallets: [{ walletId: 'wallet-a', encryptionKey: KEY_A }],
    dataSourceFactory: dataSource,
    /**
     * Report the raw chain head to the scheduler.
     * @returns Current mutable raw chain head.
     */
    getHead: () => head,
    confirmations: 5n,
    headPollMs: 5
  })

  const refresh = scheduler.requestRefresh('post-tx', { afterBlock: 100n })
  await sleep(10)
  assert.equal(client.scanCalls.length, 0, 'raw head alone did not trigger refresh')

  head = 105n
  await refresh

  assert.equal(client.scanCalls.length, 1, 'refresh ran after confirmed target caught up')
  assert.equal(client.scanCalls[0]!.endBlock, 100n)

  scheduler.stop()
})

test('minIntervalMs enforces a completed-pass gap across manual triggers', async () => {
  const client = new FakeClient()
  const scanStarts: number[] = []
  const scanEnds: number[] = []
  /**
   * Record pass start/end timestamps.
   * @param params - Scan parameters.
   * @returns The scanned-to block.
   */
  client.scanImpl = async (params) => {
    scanStarts.push(Date.now())
    scanEnds.push(Date.now())
    return params.endBlock
  }
  const scheduler = new BalanceSyncScheduler({
    client,
    network: NetworkName.EthereumSepolia,
    wallets: [{ walletId: 'wallet-a', encryptionKey: KEY_A }],
    dataSourceFactory: dataSource,
    /**
     * Report the raw chain head to the scheduler.
     * @returns Fixed raw chain head.
     */
    getHead: () => 10n,
    minIntervalMs: 25
  })

  await scheduler.requestRefresh()
  await scheduler.requestRefresh()

  assert.equal(client.scanCalls.length, 2)
  assert.ok(
    scanStarts[1]! - scanEnds[0]! >= 18,
    'second pass waited for the minimum gap after first completion'
  )

  scheduler.stop()
})

test('failures back off and reset after the next successful pass', async () => {
  const client = new FakeClient()
  let shouldFail = true
  const observedErrors: Array<{ message: string, failures: number }> = []
  /**
   * Fail until `shouldFail` is cleared, then succeed.
   * @returns The scanned-to block on success.
   */
  client.scanImpl = async () => {
    if (shouldFail) {
      throw new Error('scan failed')
    }
    return 10n
  }
  const scheduler = new BalanceSyncScheduler({
    client,
    network: NetworkName.EthereumSepolia,
    wallets: [{ walletId: 'wallet-a', encryptionKey: KEY_A }],
    dataSourceFactory: dataSource,
    /**
     * Report the raw chain head to the scheduler.
     * @returns Fixed raw chain head.
     */
    getHead: () => 10n,
    backoff: { initialMs: 20, maxMs: 50, multiplier: 2 },
    /**
     * Capture each error and the running failure count.
     * @param error - The error thrown by the failed pass.
     * @param context - Scheduler error context.
     */
    onError: (error, context) => {
      observedErrors.push({
        message: error instanceof Error ? error.message : String(error),
        failures: context.consecutiveFailures
      })
    }
  })

  await assert.rejects(
    () => scheduler.requestRefresh(),
    /scan failed/
  )
  assert.equal(scheduler.getState().consecutiveFailures, 1)
  assert.deepEqual(observedErrors, [{ message: 'scan failed', failures: 1 }])

  shouldFail = false
  const retriedAt = Date.now()
  await scheduler.requestRefresh()

  assert.ok(Date.now() - retriedAt >= 15, 'second pass honored backoff')
  assert.equal(scheduler.getState().consecutiveFailures, 0)
  assert.ok(scheduler.getState().lastSyncedAt)

  scheduler.stop()
})

test('post-tx requests during an active pass collapse to one queued follow-up', async () => {
  const client = new FakeClient()
  const firstScan = deferred<void>()
  let head = 10n
  /**
   * Block the first pass on `firstScan` so later requests can queue up.
   * @param params - Scan parameters.
   * @param callNumber - 1-based call index.
   * @returns The scanned-to block.
   */
  client.scanImpl = async (params, callNumber) => {
    if (callNumber === 1) {
      await firstScan.promise
    }
    return params.endBlock
  }
  const scheduler = new BalanceSyncScheduler({
    client,
    network: NetworkName.EthereumSepolia,
    wallets: [{ walletId: 'wallet-a', encryptionKey: KEY_A }],
    dataSourceFactory: dataSource,
    /**
     * Report the raw chain head to the scheduler.
     * @returns Current mutable raw chain head.
     */
    getHead: () => head,
    confirmations: 0n,
    headPollMs: 5
  })

  const initial = scheduler.requestRefresh()
  await waitFor(() => client.scanCalls.length === 1)

  const queuedA = scheduler.requestRefresh('post-tx', { afterBlock: 20n })
  const queuedB = scheduler.requestRefresh('post-tx', { afterBlock: 18n })
  head = 20n
  firstScan.resolve()

  await Promise.all([initial, queuedA, queuedB])

  assert.equal(client.scanCalls.length, 2, 'only one follow-up scan ran')
  assert.equal(client.scanCalls[1]!.endBlock, 20n)

  scheduler.stop()
})

test('wallets added and removed during a scan affect later decrypts', async () => {
  const client = new FakeClient()
  const firstScan = deferred<void>()
  /**
   * Block the pass on `firstScan` so wallets can change mid-scan.
   * @param params - Scan parameters.
   * @returns The scanned-to block.
   */
  client.scanImpl = async (params) => {
    await firstScan.promise
    return params.endBlock
  }
  const scheduler = new BalanceSyncScheduler({
    client,
    network: NetworkName.EthereumSepolia,
    wallets: [{ walletId: 'wallet-a', encryptionKey: KEY_A }],
    dataSourceFactory: dataSource,
    /**
     * Report the raw chain head to the scheduler.
     * @returns Fixed raw chain head.
     */
    getHead: () => 10n
  })

  const refresh = scheduler.requestRefresh()
  await waitFor(() => client.scanCalls.length === 1)

  scheduler.addWallet({ walletId: 'wallet-b', encryptionKey: KEY_B })
  scheduler.removeWallet('wallet-a')
  firstScan.resolve()
  await refresh

  assert.deepEqual(
    client.decryptCalls.map(call => call.walletId),
    ['wallet-b'],
    'removed wallet was skipped and added wallet joined the pass'
  )

  scheduler.stop()
})

test('stop rejects queued post-tx work and prevents later scans', async () => {
  const client = new FakeClient()
  const scheduler = new BalanceSyncScheduler({
    client,
    network: NetworkName.EthereumSepolia,
    wallets: [{ walletId: 'wallet-a', encryptionKey: KEY_A }],
    dataSourceFactory: dataSource,
    /**
     * Report the raw chain head to the scheduler.
     * @returns Fixed raw chain head.
     */
    getHead: () => 0n,
    headPollMs: 5
  })

  const refresh = scheduler.requestRefresh('post-tx', { afterBlock: 10n })
  await sleep(5)
  scheduler.stop()

  await assert.rejects(
    refresh,
    (error: unknown) => error instanceof BalanceSyncSchedulerStoppedError
  )
  await sleep(10)
  assert.equal(client.scanCalls.length, 0)
  assert.equal(scheduler.getState().status, 'stopped')
})

test('start schedules periodic refreshes from the end of each pass', async () => {
  const client = new FakeClient()
  const scheduler = new BalanceSyncScheduler({
    client,
    network: NetworkName.EthereumSepolia,
    wallets: [{ walletId: 'wallet-a', encryptionKey: KEY_A }],
    dataSourceFactory: dataSource,
    /**
     * Report the raw chain head to the scheduler.
     * @returns Fixed raw chain head.
     */
    getHead: () => 10n,
    intervalMs: 25
  })

  scheduler.start()
  await waitFor(() => client.scanCalls.length === 1)
  await sleep(12)
  assert.equal(client.scanCalls.length, 1, 'periodic timer did not fire early')

  await waitFor(() => client.scanCalls.length >= 2)
  assert.equal(client.scanCalls.length, 2)

  scheduler.stop()
})
