import { test } from 'brittle'

import { EventBus } from '../../src/events/bus'

/**
 * Default balance:update payload — override only fields a test cares about.
 * @param overrides - Fields to override on the default payload.
 * @returns Complete BalanceUpdateEvent shape.
 */
function balancePayload (overrides: Partial<{
  walletId: string
  chainId: number
}> = {}) {
  return {
    walletId: 'w',
    chainId: 1,
    balances: [],
    notesAdded: 0,
    notesSpent: 0,
    timestamp: new Date(),
    ...overrides
  }
}

/**
 * Default sync:start payload.
 * @param overrides - Fields to override.
 * @returns Complete SyncStartEvent shape.
 */
function startPayload (overrides: Partial<{ chainId: number }> = {}) {
  return {
    chainId: 1,
    phase: 'sync' as const,
    timestamp: new Date(),
    ...overrides
  }
}

test('EventBus.on returns an unsubscribe that removes the handler', (t) => {
  const bus = new EventBus()
  const seen: number[] = []
  const unsub = bus.on('balance:update', () => seen.push(1))
  bus.emit('balance:update', balancePayload())
  unsub()
  bus.emit('balance:update', balancePayload())
  t.is(seen.length, 1, 'handler fires once before unsub, never after')
})

test('unsubscribe is idempotent', (t) => {
  const bus = new EventBus()
  const unsub = bus.on('sync:start', () => {})
  unsub()
  t.execution(() => unsub(), 'second call must not throw')
})

test('handlers fire in registration order', (t) => {
  const bus = new EventBus()
  const seen: string[] = []
  bus.on('sync:start', () => seen.push('a'))
  bus.on('sync:start', () => seen.push('b'))
  bus.on('sync:start', () => seen.push('c'))
  bus.emit('sync:start', startPayload())
  t.alike(seen, ['a', 'b', 'c'])
})

test('multiple subscribers to the same event all fire', (t) => {
  const bus = new EventBus()
  let hits = 0
  bus.on('sync:start', () => { hits += 1 })
  bus.on('sync:start', () => { hits += 1 })
  bus.on('sync:start', () => { hits += 1 })
  bus.emit('sync:start', startPayload())
  t.is(hits, 3)
})

test('walletId filter skips events without walletId', (t) => {
  const bus = new EventBus()
  let hits = 0
  bus.on('sync:progress', () => { hits += 1 }, { walletId: 'w1' })
  bus.emit('sync:progress', {
    chainId: 1,
    phase: 'scan',
    fromBlock: 0n,
    toBlock: 100n,
    currentBlock: 100n,
    blocksScanned: 100n,
    notesAdded: 0,
    notesSpent: 0,
    timestamp: new Date()
  })
  t.is(hits, 0)
})

test('walletId filter matches only that wallet', (t) => {
  const bus = new EventBus()
  const seen: string[] = []
  bus.on('balance:update', (e) => seen.push(e.walletId), { walletId: 'wA' })
  bus.emit('balance:update', balancePayload({ walletId: 'wA' }))
  bus.emit('balance:update', balancePayload({ walletId: 'wB' }))
  t.alike(seen, ['wA'])
})

test('chainId filter matches only that chain', (t) => {
  const bus = new EventBus()
  const seen: number[] = []
  bus.on('balance:update', (e) => seen.push(e.chainId), { chainId: 11155111 })
  bus.emit('balance:update', balancePayload({ chainId: 1 }))
  bus.emit('balance:update', balancePayload({ chainId: 11155111 }))
  t.alike(seen, [11155111])
})

test('combined filter requires every field to match', (t) => {
  const bus = new EventBus()
  let hits = 0
  bus.on('balance:update', () => { hits += 1 }, { walletId: 'w', chainId: 1 })
  bus.emit('balance:update', balancePayload({ walletId: 'w', chainId: 1 }))
  bus.emit('balance:update', balancePayload({ walletId: 'w', chainId: 2 }))
  bus.emit('balance:update', balancePayload({ walletId: 'x', chainId: 1 }))
  t.is(hits, 1)
})

test('no filter is firehose', (t) => {
  const bus = new EventBus()
  let hits = 0
  bus.on('balance:update', () => { hits += 1 })
  bus.emit('balance:update', balancePayload({ walletId: 'a', chainId: 1 }))
  bus.emit('balance:update', balancePayload({ walletId: 'b', chainId: 2 }))
  t.is(hits, 2)
})

test('throwing handler is isolated; later handlers still run; error event emitted', (t) => {
  const bus = new EventBus()
  const seen: string[] = []
  bus.on('balance:update', () => { throw new Error('boom') })
  bus.on('balance:update', () => seen.push('after'))
  const errors: string[] = []
  bus.on('error', (e) => errors.push(e.error.message))
  bus.emit('balance:update', balancePayload())
  t.alike(seen, ['after'])
  t.alike(errors, ['boom'])
})

test('throwing inside an error-handler does not recurse', (t) => {
  const bus = new EventBus()
  bus.on('error', () => { throw new Error('error-handler boom') })
  bus.on('balance:update', () => { throw new Error('inner boom') })
  // If recursion existed, this would loop forever. We just must not throw.
  t.execution(() => bus.emit('balance:update', balancePayload()))
})

test('removeAllListeners() clears every event', (t) => {
  const bus = new EventBus()
  let hits = 0
  bus.on('balance:update', () => { hits += 1 })
  bus.on('sync:start', () => { hits += 1 })
  bus.removeAllListeners()
  bus.emit('balance:update', balancePayload())
  bus.emit('sync:start', startPayload())
  t.is(hits, 0)
})

test('removeAllListeners(event) clears only that event', (t) => {
  const bus = new EventBus()
  let bal = 0
  let start = 0
  bus.on('balance:update', () => { bal += 1 })
  bus.on('sync:start', () => { start += 1 })
  bus.removeAllListeners('balance:update')
  bus.emit('balance:update', balancePayload())
  bus.emit('sync:start', startPayload())
  t.is(bal, 0)
  t.is(start, 1)
})
