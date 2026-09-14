import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { BackfillCheckpoint } from '../src/types/storage.ts'
import {
  rollingRefreshIsDue,
  runWithSyncWatchdog,
  SYNC_INTERVAL_MS,
} from '../src/utils/sync.ts'
import { initialCheckpoint } from '../src/utils/storage.ts'

const NOW = Date.UTC(2026, 8, 14)

function complete(): BackfillCheckpoint {
  return { ...initialCheckpoint('newer_than:45d'), status: 'complete' }
}

test('a completed rolling window refreshes every five minutes', () => {
  assert.equal(rollingRefreshIsDue(complete(), NOW - SYNC_INTERVAL_MS + 1, NOW), false)
  assert.equal(rollingRefreshIsDue(complete(), NOW - SYNC_INTERVAL_MS, NOW), true)
})

test('an unfinished checkpoint is never reset by a periodic wake', () => {
  assert.equal(rollingRefreshIsDue(initialCheckpoint('newer_than:45d'), undefined, NOW, true), false)
})

test('connect can force a completed window to check for new mail immediately', () => {
  assert.equal(rollingRefreshIsDue(complete(), NOW, NOW, true), true)
})

test('a continuation watchdog is armed before a sync slice can remain in flight', async () => {
  const events: string[] = []
  let finishSlice: (() => void) | undefined
  const slice = new Promise<void>((resolve) => {
    finishSlice = resolve
  })

  const run = runWithSyncWatchdog(
    async () => {
      events.push('watchdog-armed')
    },
    async () => {
      events.push('slice-started')
      await slice
      events.push('slice-finished')
    },
  )

  await Promise.resolve()
  assert.deepEqual(events, ['watchdog-armed', 'slice-started'])
  finishSlice?.()
  await run
  assert.deepEqual(events, ['watchdog-armed', 'slice-started', 'slice-finished'])
})

test('a long slice keeps replacing its continuation watchdog', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let arms = 0
  let finish: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    finish = resolve
  })

  const run = runWithSyncWatchdog(
    async () => {
      arms += 1
    },
    async () => await blocked,
  )

  await Promise.resolve()
  t.mock.timers.tick(40_000)
  await Promise.resolve()
  assert.equal(arms, 3, 'initial arm plus two replacement alarms')

  finish?.()
  await run
  t.mock.timers.tick(40_000)
  assert.equal(arms, 3, 'the timer is cleared when the slice ends')
})
