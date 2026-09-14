import assert from 'node:assert/strict'
import test from 'node:test'
import type { BackfillCheckpoint } from '../src/types/storage.ts'
import { SYNC_INTERVAL_MS, shouldRelistWindow } from '../src/utils/sync.ts'

const NOW = 1_800_000_000_000

const complete = (): BackfillCheckpoint => ({
  status: 'complete',
  query: 'newer_than:45d',
  currentPageMessageIds: [],
  nextPageToken: null,
  processedCount: 400,
  extractorVersion: 1,
  nextAttemptAt: null,
  attempts: {},
})

test('an idle mailbox with a cursor is never re-listed', () => {
  // The symptom this fixes: the five-minute alarm wiping the checkpoint and
  // re-walking the whole window even when no mail had arrived.
  assert.equal(
    shouldRelistWindow({
      checkpoint: complete(),
      historyCursor: '900123',
      lastSync: NOW - 10 * SYNC_INTERVAL_MS,
      now: NOW,
    }),
    false,
  )
})

test('not even a forced wake re-lists while the cursor is good', () => {
  assert.equal(
    shouldRelistWindow({
      checkpoint: complete(),
      historyCursor: '900123',
      lastSync: undefined,
      now: NOW,
      force: true,
    }),
    false,
    'the periodic alarm forces, so this is the path that was re-listing',
  )
})

test('a dropped cursor falls back to re-listing the window', () => {
  // This is the state left behind by a 404 from history.list.
  assert.equal(
    shouldRelistWindow({
      checkpoint: complete(),
      historyCursor: undefined,
      lastSync: NOW - SYNC_INTERVAL_MS,
      now: NOW,
    }),
    true,
  )
})

test('an unfinished first scan is never interrupted by a re-list', () => {
  assert.equal(
    shouldRelistWindow({
      checkpoint: { ...complete(), status: 'running' },
      historyCursor: undefined,
      lastSync: NOW - SYNC_INTERVAL_MS,
      now: NOW,
    }),
    false,
    'resetting mid-scan would restart the backfill from page one',
  )
})

test('without a cursor the re-list still waits for the interval', () => {
  assert.equal(
    shouldRelistWindow({
      checkpoint: complete(),
      historyCursor: undefined,
      lastSync: NOW - 60_000,
      now: NOW,
    }),
    false,
  )
})
