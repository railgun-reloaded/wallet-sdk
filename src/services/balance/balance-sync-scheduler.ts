import type { EVMBlock, SourceAggregator } from '@railgun-reloaded/scanner'

import type {
  DecryptParams,
  RailgunClient,
  ScanParams
} from '../../client'
import type { NetworkName } from '../../network-config'
import { NETWORK_CONFIG } from '../../network-config'

type BalanceSyncSchedulerClient = Pick<RailgunClient, 'scan' | 'decrypt'>

type BalanceSyncSchedulerWallet = {
  walletId: string
} & (
  | { encryptionKey: Uint8Array }
  | { getEncryptionKey: () => Uint8Array | Promise<Uint8Array> }
)

type BalanceSyncDataSourceFactory = (
  () => SourceAggregator<EVMBlock> | Promise<SourceAggregator<EVMBlock>>
)

type BalanceSyncHeadProvider = () => bigint | Promise<bigint>

type BalanceSyncBackoffOptions = {
  initialMs?: number
  maxMs?: number
  multiplier?: number
}

type BalanceSyncRefreshReason = string

type BalanceSyncRefreshOptions = {
  afterBlock?: bigint
}

type BalanceSyncSchedulerStatus =
  | 'stopped'
  | 'idle'
  | 'waiting'
  | 'refreshing'
  | 'backoff'

type BalanceSyncSchedulerWalletState = {
  walletId: string
  status: 'active'
  lastDecryptedAt?: Date
}

type BalanceSyncSchedulerState = {
  status: BalanceSyncSchedulerStatus
  lastSyncedAt?: Date
  nextFireAt?: Date
  consecutiveFailures: number
  wallets: BalanceSyncSchedulerWalletState[]
}

type BalanceSyncSchedulerErrorContext = {
  reason: BalanceSyncRefreshReason
  afterBlock?: bigint
  consecutiveFailures: number
}

type BalanceSyncSchedulerConfig = {
  client: BalanceSyncSchedulerClient
  network: NetworkName
  wallets?: BalanceSyncSchedulerWallet[]
  dataSourceFactory: BalanceSyncDataSourceFactory
  getHead?: BalanceSyncHeadProvider
  intervalMs?: number
  minIntervalMs?: number
  confirmations?: bigint | number
  headPollMs?: number
  backoff?: BalanceSyncBackoffOptions
  onError?: (error: unknown, context: BalanceSyncSchedulerErrorContext) => void
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

type PendingRefresh = {
  reason: BalanceSyncRefreshReason
  afterBlock?: bigint
  deferred: Deferred<void>
}

type ActiveRefresh = {
  promise: Promise<void>
  coversThrough?: bigint
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_MIN_INTERVAL_MS = 0
const DEFAULT_HEAD_POLL_MS = 1_000
const DEFAULT_BACKOFF_INITIAL_MS = 1_000
const DEFAULT_BACKOFF_MAX_MS = 30_000
const DEFAULT_BACKOFF_MULTIPLIER = 2

/**
 * Raised when work is requested after the scheduler has been stopped.
 */
class BalanceSyncSchedulerStoppedError extends Error {
  /**
   * Create a stopped-scheduler error.
   */
  constructor () {
    super('BalanceSyncScheduler is stopped')
    this.name = 'BalanceSyncSchedulerStoppedError'
  }
}

/**
 * Optional balance refresh coordinator for one chain and many wallets.
 *
 * The scheduler is a consumer of `RailgunClient.scan()` and
 * `RailgunClient.decrypt()`: one pass scans the chain once, then decrypts for
 * every active wallet target. Existing client events remain the balance and
 * sync lifecycle source of truth.
 */
class BalanceSyncScheduler {
  /** Client used for scan/decrypt primitives. */
  readonly #client: BalanceSyncSchedulerClient
  /** Network scanned by this scheduler instance. */
  readonly #network: NetworkName
  /** Chain ID derived from the configured network. */
  readonly #chainId: number
  /** Factory for creating scan data sources. */
  readonly #dataSourceFactory: BalanceSyncDataSourceFactory
  /** Optional chain-head provider used for confirmed targets. */
  readonly #getHead: BalanceSyncHeadProvider | undefined
  /** Active wallet targets keyed by wallet ID. */
  readonly #wallets = new Map<string, BalanceSyncSchedulerWallet>()
  /** Last successful decrypt timestamp per wallet. */
  readonly #lastDecryptedAt = new Map<string, Date>()
  /** Delay between periodic refreshes, measured from pass completion. */
  readonly #intervalMs: number
  /** Minimum gap between any two completed passes. */
  readonly #minIntervalMs: number
  /** Number of confirmations subtracted from the current head. */
  readonly #confirmations: bigint
  /** Poll interval while waiting for a post-transaction target. */
  readonly #headPollMs: number
  /** First retry delay after a failed pass. */
  readonly #backoffInitialMs: number
  /** Maximum retry delay after repeated failures. */
  readonly #backoffMaxMs: number
  /** Multiplier applied to consecutive failure retries. */
  readonly #backoffMultiplier: number
  /** Optional scheduler-level error observer. */
  readonly #onError: BalanceSyncSchedulerConfig['onError']
  /** Current public scheduler status. */
  #status: BalanceSyncSchedulerStatus = 'idle'
  /** True when interval-driven refreshes are enabled. */
  #periodicEnabled = false
  /** True once stop() has disabled new work. */
  #stopped = false
  /** Current scheduler timer, if any. */
  #timer: ReturnType<typeof setTimeout> | undefined
  /** Public timestamp for the current timer fire time. */
  #nextFireAt: Date | undefined
  /** Millisecond timestamp of the last settled pass. */
  #lastCompletedAt: number | undefined
  /** Wall-clock timestamp of the last successful pass. */
  #lastSyncedAt: Date | undefined
  /** Earliest millisecond timestamp allowed after a failure. */
  #nextRetryAt: number | undefined
  /** Number of consecutive failed passes. */
  #consecutiveFailures = 0
  /** Single queued follow-up refresh. */
  #pending: PendingRefresh | undefined
  /** Active refresh pass shared by concurrent callers. */
  #active: ActiveRefresh | undefined

  /**
   * Create a scheduler for one network.
   * @param config - Scheduler dependencies and timing options.
   */
  constructor (config: BalanceSyncSchedulerConfig) {
    this.#client = config.client
    this.#network = config.network
    this.#chainId = NETWORK_CONFIG[config.network].chainID
    this.#dataSourceFactory = config.dataSourceFactory
    this.#getHead = config.getHead

    const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS
    const minIntervalMs = config.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    const headPollMs = config.headPollMs ?? DEFAULT_HEAD_POLL_MS
    const backoffInitialMs = config.backoff?.initialMs ?? DEFAULT_BACKOFF_INITIAL_MS
    const backoffMaxMs = config.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS
    for (const [name, value] of [
      ['intervalMs', intervalMs],
      ['minIntervalMs', minIntervalMs],
      ['headPollMs', headPollMs],
      ['backoff.initialMs', backoffInitialMs],
      ['backoff.maxMs', backoffMaxMs]
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative finite number`)
      }
    }

    const confirmations = config.confirmations ?? 0n
    if (
      typeof confirmations === 'number' &&
      (!Number.isFinite(confirmations) || !Number.isInteger(confirmations))
    ) {
      throw new RangeError('confirmations must be an integer')
    }
    this.#confirmations = typeof confirmations === 'bigint'
      ? confirmations
      : BigInt(confirmations)
    if (this.#confirmations < 0n) {
      throw new RangeError('confirmations must be non-negative')
    }

    const backoffMultiplier = config.backoff?.multiplier ?? DEFAULT_BACKOFF_MULTIPLIER
    if (!Number.isFinite(backoffMultiplier) || backoffMultiplier < 1) {
      throw new RangeError('backoff.multiplier must be greater than or equal to 1')
    }

    this.#intervalMs = intervalMs
    this.#minIntervalMs = minIntervalMs
    this.#headPollMs = headPollMs
    this.#backoffInitialMs = backoffInitialMs
    this.#backoffMaxMs = backoffMaxMs
    this.#backoffMultiplier = backoffMultiplier
    this.#onError = config.onError

    for (const wallet of config.wallets ?? []) {
      this.addWallet(wallet)
    }
  }

  /**
   * Enable periodic refreshes and queue the initial pass.
   */
  start (): void {
    this.#stopped = false
    this.#periodicEnabled = true
    if (!this.#active && !this.#pending) {
      this.#status = 'idle'
      this.#queueRefresh('interval').catch(() => {})
    }
  }

  /**
   * Disable future scheduler work. In-flight client calls are allowed to
   * finish, but queued work is rejected and timers are cleared.
   */
  stop (): void {
    this.#periodicEnabled = false
    this.#stopped = true
    this.#clearTimer()

    if (this.#pending) {
      this.#pending.deferred.reject(new BalanceSyncSchedulerStoppedError())
      this.#pending = undefined
    }

    this.#status = 'stopped'
  }

  /**
   * Request a refresh and resolve once the pass satisfying the request
   * completes. Concurrent requests coalesce into active or queued work.
   * @param reason - Optional reason tag for diagnostics.
   * @param options - Optional trigger options.
   * @returns Resolves when the satisfying pass completes.
   */
  requestRefresh (
    reason: BalanceSyncRefreshReason = 'manual',
    options: BalanceSyncRefreshOptions = {}
  ): Promise<void> {
    return this.#queueRefresh(reason, options)
  }

  /**
   * Add or replace a wallet target.
   * @param wallet - Wallet target.
   */
  addWallet (wallet: BalanceSyncSchedulerWallet): void {
    this.#wallets.set(wallet.walletId, wallet)
  }

  /**
   * Remove a wallet target from later decrypt passes.
   * @param walletId - Wallet to remove.
   */
  removeWallet (walletId: string): void {
    this.#wallets.delete(walletId)
    this.#lastDecryptedAt.delete(walletId)
  }

  /**
   * Return an operational snapshot of the scheduler.
   * @returns Current scheduler state.
   */
  getState (): BalanceSyncSchedulerState {
    const state: BalanceSyncSchedulerState = {
      status: this.#status,
      consecutiveFailures: this.#consecutiveFailures,
      wallets: Array.from(this.#wallets.keys()).map((walletId) => {
        const walletState: BalanceSyncSchedulerWalletState = {
          walletId,
          status: 'active'
        }
        const lastDecryptedAt = this.#lastDecryptedAt.get(walletId)
        if (lastDecryptedAt) {
          walletState.lastDecryptedAt = new Date(lastDecryptedAt)
        }
        return walletState
      })
    }

    if (this.#lastSyncedAt) {
      state.lastSyncedAt = new Date(this.#lastSyncedAt)
    }
    if (this.#nextFireAt) {
      state.nextFireAt = new Date(this.#nextFireAt)
    }

    return state
  }

  /**
   * Queue a refresh or attach to existing active/queued work.
   * @param reason - Diagnostic reason associated with the refresh.
   * @param options - Optional post-transaction gate.
   * @returns Promise resolved when matching work completes.
   */
  async #queueRefresh (
    reason: BalanceSyncRefreshReason,
    options: BalanceSyncRefreshOptions = {}
  ): Promise<void> {
    if (this.#stopped) {
      throw new BalanceSyncSchedulerStoppedError()
    }

    const afterBlock = options.afterBlock
    if (reason === 'post-tx' && afterBlock === undefined) {
      throw new TypeError('post-tx refresh requires afterBlock')
    }
    if (afterBlock !== undefined && afterBlock < 0n) {
      throw new RangeError('afterBlock must be non-negative')
    }

    if (this.#active && this.#activeCoversRequest(afterBlock)) {
      return this.#active.promise
    }

    if (this.#pending) {
      this.#mergePending(reason, afterBlock)
      return this.#pending.deferred.promise
    }

    if (!this.#active) {
      this.#clearTimer()
    }

    const pending: PendingRefresh = {
      reason,
      deferred: createDeferred<void>()
    }
    if (afterBlock !== undefined) {
      pending.afterBlock = afterBlock
    }
    this.#pending = pending
    this.#schedulePendingDrain()
    return pending.deferred.promise
  }

  /**
   * Check whether the active pass will satisfy a requested block target.
   * @param afterBlock - Optional confirmed block target.
   * @returns True when no follow-up pass is needed.
   */
  #activeCoversRequest (afterBlock: bigint | undefined): boolean {
    if (afterBlock === undefined) {
      return true
    }
    return this.#active?.coversThrough !== undefined &&
      this.#active.coversThrough >= afterBlock
  }

  /**
   * Collapse a newer request into the single queued follow-up pass.
   * @param reason - Latest refresh reason.
   * @param afterBlock - Optional target block to cover.
   */
  #mergePending (
    reason: BalanceSyncRefreshReason,
    afterBlock: bigint | undefined
  ): void {
    if (!this.#pending) return
    if (reason === 'post-tx') {
      this.#pending.reason = reason
    }
    if (
      afterBlock !== undefined &&
      (
        this.#pending.afterBlock === undefined ||
        afterBlock > this.#pending.afterBlock
      )
    ) {
      this.#pending.afterBlock = afterBlock
    }
  }

  /**
   * Schedule the queued pass after any min-interval or backoff delay.
   */
  #schedulePendingDrain (): void {
    if (!this.#pending || this.#active || this.#stopped) {
      return
    }

    const delayMs = this.#delayUntilNextAllowedPass()
    if (delayMs > 0) {
      this.#status = this.#nextRetryAt !== undefined ? 'backoff' : 'waiting'
      this.#setTimer(() => { this.#drainPending().catch(() => {}) }, delayMs)
      return
    }

    this.#drainPending().catch(() => {})
  }

  /**
   * Run the queued pass once timing and confirmation gates allow it.
   */
  async #drainPending (): Promise<void> {
    if (!this.#pending || this.#active || this.#stopped) {
      return
    }

    this.#clearTimer()

    let coversThrough: bigint | undefined
    try {
      coversThrough = await this.#resolveConfirmedTarget()
    } catch (err) {
      this.#failPending(err)
      return
    }

    if (!this.#pending || this.#stopped) {
      return
    }

    const pending = this.#pending
    if (
      pending.afterBlock !== undefined &&
      (
        coversThrough === undefined ||
        coversThrough < pending.afterBlock
      )
    ) {
      this.#status = 'waiting'
      this.#setTimer(() => { this.#drainPending().catch(() => {}) }, this.#headPollMs)
      return
    }

    this.#pending = undefined
    this.#status = 'refreshing'
    const promise = this.#runPass(coversThrough)
    this.#active = { promise }
    if (coversThrough !== undefined) {
      this.#active.coversThrough = coversThrough
    }

    try {
      await promise
      const now = Date.now()
      this.#lastCompletedAt = now
      this.#lastSyncedAt = new Date(now)
      this.#consecutiveFailures = 0
      this.#nextRetryAt = undefined
      pending.deferred.resolve()
    } catch (err) {
      const now = Date.now()
      this.#lastCompletedAt = now
      this.#consecutiveFailures += 1
      this.#nextRetryAt = now + this.#currentBackoffMs()
      this.#notifyError(err, pending)
      pending.deferred.reject(err)
    } finally {
      this.#active = undefined
      this.#afterPass()
    }
  }

  /**
   * Reject queued work when pre-run gating fails.
   * @param err - Failure from resolving the next runnable target.
   */
  #failPending (err: unknown): void {
    const pending = this.#pending
    if (!pending) return

    const now = Date.now()
    this.#lastCompletedAt = now
    this.#consecutiveFailures += 1
    this.#nextRetryAt = now + this.#currentBackoffMs()
    this.#pending = undefined
    this.#notifyError(err, pending)
    pending.deferred.reject(err)
    this.#afterPass()
  }

  /**
   * Resume queued or periodic work after a pass settles.
   */
  #afterPass (): void {
    if (this.#stopped) {
      this.#status = 'stopped'
      return
    }

    if (this.#pending) {
      this.#schedulePendingDrain()
      return
    }

    this.#status = 'idle'
    this.#schedulePeriodic()
  }

  /**
   * Execute one scan-once/decrypt-many pass.
   * @param endBlock - Optional confirmed block ceiling.
   */
  async #runPass (endBlock: bigint | undefined): Promise<void> {
    if (this.#wallets.size === 0) {
      return
    }

    // TODO(data-source-lifecycle): The ticket originally asked for a
    // long-lived data source, but RailgunClient.scan() installs the source on
    // RailgunEngine and RailgunEngine.setDataSource() destroys the previous
    // source. Keep sources per pass until engine/client expose a reusable
    // lifecycle that can be released explicitly on stop().
    const dataSource = await this.#dataSourceFactory()
    const scanParams: ScanParams = {
      network: this.#network,
      dataSource
    }
    if (endBlock !== undefined) {
      scanParams.endBlock = endBlock
    }

    await this.#client.scan(scanParams)

    for (const walletId of Array.from(this.#wallets.keys())) {
      const wallet = this.#wallets.get(walletId)
      if (!wallet) continue

      const decryptParams: DecryptParams = {
        chainId: this.#chainId
      }
      if (endBlock !== undefined) {
        decryptParams.toBlock = endBlock
      }

      const encryptionKey = await resolveEncryptionKey(wallet)
      await this.#client.decrypt(wallet.walletId, encryptionKey, decryptParams)
      this.#lastDecryptedAt.set(wallet.walletId, new Date())
    }
  }

  /**
   * Resolve the confirmed head used as the next scan/decrypt ceiling.
   * @returns Confirmed block target, or undefined when no head provider exists.
   */
  async #resolveConfirmedTarget (): Promise<bigint | undefined> {
    if (!this.#getHead) {
      return undefined
    }

    const head = await this.#getHead()
    return head > this.#confirmations
      ? head - this.#confirmations
      : 0n
  }

  /**
   * Calculate the remaining delay imposed by min interval and backoff state.
   * @returns Delay in milliseconds before another pass may start.
   */
  #delayUntilNextAllowedPass (): number {
    const now = Date.now()
    let delayMs = 0

    if (this.#lastCompletedAt !== undefined && this.#minIntervalMs > 0) {
      delayMs = Math.max(delayMs, this.#lastCompletedAt + this.#minIntervalMs - now)
    }

    if (this.#nextRetryAt !== undefined) {
      delayMs = Math.max(delayMs, this.#nextRetryAt - now)
    }

    return Math.max(0, delayMs)
  }

  /**
   * Calculate the retry delay for the current failure streak.
   * @returns Backoff delay in milliseconds.
   */
  #currentBackoffMs (): number {
    const scaled = this.#backoffInitialMs *
      (this.#backoffMultiplier ** Math.max(0, this.#consecutiveFailures - 1))
    return Math.min(this.#backoffMaxMs, scaled)
  }

  /**
   * Queue the next interval-driven refresh after the previous pass finishes.
   */
  #schedulePeriodic (): void {
    if (
      !this.#periodicEnabled ||
      this.#stopped ||
      this.#active ||
      this.#pending
    ) {
      return
    }

    const delayMs = Math.max(
      this.#intervalMs,
      this.#delayUntilNextAllowedPass()
    )
    this.#setTimer(() => {
      this.#queueRefresh('interval').catch(() => {})
    }, delayMs)
  }

  /**
   * Replace the current timer with a new scheduler timer.
   * @param callback - Function to run when the timer fires.
   * @param delayMs - Delay in milliseconds.
   */
  #setTimer (callback: () => void, delayMs: number): void {
    this.#clearTimer()
    const safeDelayMs = Math.max(0, delayMs)
    this.#nextFireAt = new Date(Date.now() + safeDelayMs)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#nextFireAt = undefined
      callback()
    }, safeDelayMs)
  }

  /**
   * Clear the scheduler timer and next-fire timestamp.
   */
  #clearTimer (): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#nextFireAt = undefined
  }

  /**
   * Notify the optional scheduler-level error observer.
   * @param err - Refresh failure.
   * @param pending - Request that failed.
   */
  #notifyError (err: unknown, pending: PendingRefresh): void {
    if (!this.#onError) return

    const context: BalanceSyncSchedulerErrorContext = {
      reason: pending.reason,
      consecutiveFailures: this.#consecutiveFailures
    }
    if (pending.afterBlock !== undefined) {
      context.afterBlock = pending.afterBlock
    }

    try {
      this.#onError(err, context)
    } catch {
      // Scheduler error observers must not break retry/backoff state.
    }
  }
}

/**
 * Create an externally resolvable promise.
 * @returns Deferred promise tuple.
 */
function createDeferred<T> (): Deferred<T> {
  let resolveDeferred!: Deferred<T>['resolve']
  let rejectDeferred!: Deferred<T>['reject']
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
 * Resolve a static or lazy wallet encryption key.
 * @param wallet - Wallet target.
 * @returns Encryption key used to decrypt wallet notes.
 */
async function resolveEncryptionKey (
  wallet: BalanceSyncSchedulerWallet
): Promise<Uint8Array> {
  if ('getEncryptionKey' in wallet) {
    return wallet.getEncryptionKey()
  }
  return wallet.encryptionKey
}

export {
  BalanceSyncScheduler,
  BalanceSyncSchedulerStoppedError
}
export type {
  BalanceSyncBackoffOptions,
  BalanceSyncDataSourceFactory,
  BalanceSyncHeadProvider,
  BalanceSyncRefreshOptions,
  BalanceSyncRefreshReason,
  BalanceSyncSchedulerClient,
  BalanceSyncSchedulerConfig,
  BalanceSyncSchedulerErrorContext,
  BalanceSyncSchedulerState,
  BalanceSyncSchedulerStatus,
  BalanceSyncSchedulerWallet,
  BalanceSyncSchedulerWalletState
}
