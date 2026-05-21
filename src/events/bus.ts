import type {
  EventFilter,
  EventHandler,
  RailgunEventMap
} from './types'

type Subscriber<E extends keyof RailgunEventMap> = {
  handler: EventHandler<E>
  filter?: EventFilter
}

/**
 * Typed in-process event bus. Synchronous dispatch in registration order.
 * Subscriber errors are caught and re-emitted as `'error'`. `'error'`
 * handler exceptions are swallowed (logged) to prevent recursion.
 */
class EventBus {
  /** Subscribers keyed by event name. */
  readonly #subs = new Map<keyof RailgunEventMap, Set<Subscriber<keyof RailgunEventMap>>>()

  /**
   * Subscribe a handler. Returns an idempotent unsubscribe function.
   * @param event - Event name from RailgunEventMap.
   * @param handler - Synchronous handler invoked on each emit.
   * @param filter - Optional `{ walletId?, chainId? }`. All provided fields
   *   must match the payload for the handler to fire.
   * @returns Unsubscribe function. Calling it twice is a no-op.
   */
  on<E extends keyof RailgunEventMap> (
    event: E,
    handler: EventHandler<E>,
    filter?: EventFilter
  ): () => void {
    let bucket = this.#subs.get(event)
    if (!bucket) {
      bucket = new Set()
      this.#subs.set(event, bucket)
    }
    const sub: Subscriber<E> = filter ? { handler, filter } : { handler }
    bucket.add(sub as Subscriber<keyof RailgunEventMap>)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      bucket!.delete(sub as Subscriber<keyof RailgunEventMap>)
    }
  }

  /**
   * Emit a payload to every matching subscriber, synchronously, in
   * registration order. Handler exceptions are caught and re-emitted as
   * `'error'`; `'error'`-handler exceptions are logged.
   * @param event - Event name.
   * @param payload - Strongly-typed payload for that event.
   */
  emit<E extends keyof RailgunEventMap> (
    event: E,
    payload: RailgunEventMap[E]
  ): void {
    const bucket = this.#subs.get(event)
    if (!bucket || bucket.size === 0) return
    // Snapshot so a subscriber that unsubscribes a sibling mid-dispatch
    // doesn't mutate the iteration target.
    const subs = Array.from(bucket) as Subscriber<E>[]
    for (const sub of subs) {
      if (!matchesFilter(payload, sub.filter)) continue
      try {
        sub.handler(payload)
      } catch (err) {
        if (event === 'error') {
          // Already handling an error event; do not recurse.
          console.error('[EventBus] error-handler threw:', err)
          continue
        }
        this.#emitError(event, err)
      }
    }
  }

  /**
   * Remove subscribers. Pass an event name to clear just that event;
   * pass nothing to clear every event. Called by `RailgunClient.close()`.
   * @param event - Optional event name to scope the clear.
   */
  removeAllListeners (event?: keyof RailgunEventMap): void {
    if (event) {
      this.#subs.delete(event)
    } else {
      this.#subs.clear()
    }
  }

  /**
   * Re-emit a subscriber failure through the bus error channel.
   * @param sourceEvent - Event whose handler threw.
   * @param err - Captured thrown value.
   */
  #emitError (sourceEvent: keyof RailgunEventMap, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))
    this.emit('error', {
      event: sourceEvent,
      error,
      timestamp: new Date()
    })
  }
}

/**
 * Apply a subscription filter to a payload. Events without `walletId`
 * (scan-phase progress, etc.) are rejected by any filter that specifies
 * `walletId`.
 * @param payload - Event payload (loosely typed because filtering uses
 *   only the optional `walletId`/`chainId` fields).
 * @param filter - Optional filter set at subscribe time.
 * @returns True when every field in `filter` matches the payload.
 */
function matchesFilter (
  payload: unknown,
  filter?: EventFilter
): boolean {
  if (!filter) return true
  const p = payload as { walletId?: string, chainId?: number }
  if (filter.walletId !== undefined && p.walletId !== filter.walletId) {
    return false
  }
  if (filter.chainId !== undefined && p.chainId !== filter.chainId) {
    return false
  }
  return true
}

export { EventBus }
