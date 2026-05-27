import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initializeCrypto } from '../../src/init/crypto'

test('initializeCrypto resolves to undefined when the underlying init succeeds', async () => {
  const result = await initializeCrypto()
  assert.equal(result, undefined)
})

test('initializeCrypto returns the same Promise across calls (cached)', () => {
  const p1 = initializeCrypto()
  const p2 = initializeCrypto()
  assert.equal(p1, p2)
})

test('concurrent callers all observe the same cached Promise', async () => {
  const promises = Array.from({ length: 8 }, () => initializeCrypto())
  for (const p of promises) {
    assert.equal(p, promises[0])
  }
  await Promise.all(promises)
})
