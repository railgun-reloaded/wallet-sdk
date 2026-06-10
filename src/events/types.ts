import type { WalletBalanceBucket } from '../poi'
import type { TokenBalance } from '../services/balance/balance-service'

/**
 * Phase tag for sync lifecycle events. `sync` is the outer envelope when
 * `RailgunClient.sync()` is called; `scan` and `decrypt` mirror the inner
 * methods.
 */
type SyncPhaseTag = 'scan' | 'decrypt' | 'sync'

/**
 * Fired when a scan/decrypt/sync run begins.
 */
type SyncStartEvent = {
  walletId?: string
  chainId: number
  phase: SyncPhaseTag
  fromBlock?: bigint
  toBlock?: bigint
  timestamp: Date
}

/**
 * Fired per batch as a run progresses.
 */
type SyncProgressEvent = {
  walletId?: string
  chainId: number
  phase: 'scan' | 'decrypt'
  fromBlock: bigint
  toBlock: bigint
  currentBlock: bigint
  blocksScanned: bigint
  notesAdded: number
  notesSpent: number
  timestamp: Date
}

/**
 * Fired when a run completes successfully.
 */
type SyncCompleteEvent = {
  walletId?: string
  chainId: number
  phase: SyncPhaseTag
  blocksScanned: bigint
  notesAdded: number
  notesSpent: number
  durationMs: number
  timestamp: Date
}

/**
 * Fired when a run throws. Subscribers see this before the originating
 * method rethrows.
 */
type SyncErrorEvent = {
  walletId?: string
  chainId: number
  phase: SyncPhaseTag
  error: Error
  timestamp: Date
}

/**
 * Fired after standalone decrypt changes, or once after sync finishes decrypt
 * and optional POI refresh. Every view comes from one wallet-note snapshot.
 */
type BalanceUpdateEvent = {
  walletId: string
  chainId: number
  total: TokenBalance[]
  spendable: TokenBalance[]
  byBucket: Record<WalletBalanceBucket, TokenBalance[]>
  notesAdded: number
  notesSpent: number
  timestamp: Date
}

/**
 * Fired when a subscriber's handler throws. Carries the originating event
 * name and the captured error. Throwing inside an `'error'` handler is
 * caught by the bus and not re-emitted.
 */
type BusErrorEvent = {
  event: keyof RailgunEventMap
  error: Error
  timestamp: Date
}

/**
 * Maps every event name to its payload type. Consumed by `EventBus` and
 * `RailgunClient.on()` for type inference.
 */
type RailgunEventMap = {
  'sync:start': SyncStartEvent
  'sync:progress': SyncProgressEvent
  'sync:complete': SyncCompleteEvent
  'sync:error': SyncErrorEvent
  'balance:update': BalanceUpdateEvent
  error: BusErrorEvent
}

/**
 * Optional filter applied at subscription time. A handler fires only when
 * every provided field equals the event payload's matching field. Events
 * without `walletId` (e.g. scan-phase progress) are skipped by any filter
 * that specifies `walletId`.
 */
type EventFilter = {
  walletId?: string
  chainId?: number
}

/**
 * Subscriber handler signature. Synchronous; returning a promise has no
 * effect.
 */
type EventHandler<E extends keyof RailgunEventMap> = (
  payload: RailgunEventMap[E]
) => void

export type {
  BalanceUpdateEvent,
  BusErrorEvent,
  EventFilter,
  EventHandler,
  RailgunEventMap,
  SyncCompleteEvent,
  SyncErrorEvent,
  SyncPhaseTag,
  SyncProgressEvent,
  SyncStartEvent
}
