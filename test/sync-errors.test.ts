import assert from 'node:assert/strict'
import test from 'node:test'
import { GmailApiError } from '../src/background/gmail.ts'
import {
  DEFAULT_SYNC_RETRY_MS,
  MAX_SYNC_RETRY_MS,
  syncRetryDelay,
} from '../src/background/sync-errors.ts'
import { LlmError } from '../src/types/llm.ts'

test('temporary Gmail and network failures schedule a retry', () => {
  assert.equal(syncRetryDelay(new TypeError('offline')), DEFAULT_SYNC_RETRY_MS)
  assert.equal(syncRetryDelay(new GmailApiError(429, '/messages', 'busy')), DEFAULT_SYNC_RETRY_MS)
  assert.equal(syncRetryDelay(new GmailApiError(503, '/messages', 'down')), DEFAULT_SYNC_RETRY_MS)
  assert.equal(
    syncRetryDelay(
      new GmailApiError(403, '/messages', 'quota burst', 'userRateLimitExceeded'),
    ),
    DEFAULT_SYNC_RETRY_MS,
  )
  assert.equal(
    syncRetryDelay(new GmailApiError(403, '/messages', 'quota burst', 'RATE_LIMIT_EXCEEDED')),
    DEFAULT_SYNC_RETRY_MS,
  )
})

test('provider retry hints are honored while actionable failures remain blocked', () => {
  assert.equal(syncRetryDelay(new LlmError('rate-limit', 'slow down', 429, 90_000)), 90_000)
  assert.equal(syncRetryDelay(new LlmError('auth', 'bad key', 401)), null)
  assert.equal(syncRetryDelay(new GmailApiError(403, '/messages', 'forbidden')), null)
})

test('sync retries use persisted-attempt exponential backoff capped at 15 minutes', () => {
  const failure = new GmailApiError(503, '/messages', 'down')
  assert.equal(syncRetryDelay(failure, 1), 30_000)
  assert.equal(syncRetryDelay(failure, 2), 60_000)
  assert.equal(syncRetryDelay(failure, 3), 120_000)
  assert.equal(syncRetryDelay(failure, 20), MAX_SYNC_RETRY_MS)
})
