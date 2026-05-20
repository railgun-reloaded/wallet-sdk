import type { EventFilter, EventHandler, RailgunEventMap } from './types'

type Subscription<E extends keyof RailgunEventMap> = {
  handler: EventHandler<E>
  filter?: EventFilter
}

/**
 * Typed in-process event bus. Synchronous dispatch in registration order.
 * Subscriber errors are caught and re-emitted as `'error'`. `'error'`
 * handler exceptions are swallowed to prevent recursion.
 */
class EventBus {
  /** Subscribers keyed by event name. */
  readonly #subs = new Map<keyof RailgunEventMap, Set<Subscription<keyof RailgunEventMap>>>()

  /**
   * Subscribe a handler. Returns an idempotent unsubscribe function.
   * @param event - Event name from RailgunEventMap.
   * @param handler - Synchronous handler invoked on each emit.
   * @param filter - Optional `{ walletId?, chainId? }`.
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

    const sub: Subscription<E> = filter
      ? { handler, filter }
      : { handler }
    bucket.add(sub as Subscription<keyof RailgunEventMap>)

    let removed = false
    return () => {
      if (removed) return
      removed = true
      bucket.delete(sub as Subscription<keyof RailgunEventMap>)
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

    const subs = Array.from(bucket) as Subscription<E>[]
    for (const sub of subs) {
      if (!matchesFilter(payload, sub.filter)) continue

      try {
        sub.handler(payload)
      } catch (err) {
        if (event === 'error') {
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

  #emitError (sourceEvent: keyof RailgunEventMap, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))
    this.emit('error', {
      event: sourceEvent,
      error,
      timestamp: new Date()
    })
  }
}

function matchesFilter (
  payload: RailgunEventMap[keyof RailgunEventMap],
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
