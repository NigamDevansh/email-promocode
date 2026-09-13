import assert from 'node:assert/strict'
import test from 'node:test'
import { mapWithConcurrency } from '../src/utils/concurrency.ts'

test('preserves input order regardless of completion order', async () => {
  const delays = [30, 0, 20, 5, 10]
  const result = await mapWithConcurrency(delays, 2, async (delay, index) => {
    await new Promise((resolve) => setTimeout(resolve, delay))
    return index
  })
  assert.deepEqual(result, [0, 1, 2, 3, 4])
})

test('never exceeds the concurrency limit', async () => {
  let inFlight = 0
  let peak = 0
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 5, async () => {
    peak = Math.max(peak, ++inFlight)
    await new Promise((resolve) => setTimeout(resolve, 1))
    inFlight--
  })
  assert.equal(peak, 5)
})

test('rejects a non-positive limit', async () => {
  await assert.rejects(() => mapWithConcurrency([1], 0, async (n) => n), RangeError)
})

test('handles an empty input', async () => {
  assert.deepEqual(await mapWithConcurrency([], 5, async (n) => n), [])
})
