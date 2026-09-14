import assert from 'node:assert/strict'
import test from 'node:test'
import { runBackfillSlice } from '../src/background/backfill.ts'
import { GmailApiError } from '../src/background/gmail.ts'
import { runIncrementalSlice } from '../src/background/incremental.ts'
import type { BackfillDeps } from '../src/types/backfill.ts'
import type { GmailMessage } from '../src/types/gmail.ts'
import type { IncrementalJob } from '../src/types/incremental.ts'
import { META_KEYS } from '../src/utils/storage.ts'
import { b64url, createFakeGmail, type FakeGmail } from './helpers/fake-gmail.ts'
import { createMemoryStore, type MemoryStore } from './helpers/memory-store.ts'

const WITH_CODE = '<a href="https://shop.example/x?coupon=NEW20">Shop</a>'

function message(id: string, html: string = WITH_CODE): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(Date.UTC(2026, 8, 13)),
    labelIds: ['CATEGORY_PROMOTIONS'],
    payload: {
      mimeType: 'text/html',
      headers: [
        { name: 'From', value: 'Shop <mail@e.shop.example>' },
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'Content-Type', value: 'text/html; charset="utf-8"' },
      ],
      body: { size: html.length, data: b64url(html) },
    },
  }
}

function setup(historyPages: string[][], ids: string[] = historyPages.flat()) {
  const store = createMemoryStore()
  const messages = new Map(ids.map((id) => [id, message(id)]))
  const gmail = createFakeGmail([[]], messages)
  gmail.historyPages = historyPages

  const deps = (budget = 10): BackfillDeps => ({
    store,
    gmail,
    now: () => 1_000_000,
    random: () => 0.5,
    budget,
    backfillDays: 45,
  })

  return { store, gmail, deps }
}

const jobOf = (store: MemoryStore): IncrementalJob | undefined =>
  store.meta.get(META_KEYS.incremental) as IncrementalJob | undefined

const cursorOf = (store: MemoryStore): string | undefined =>
  store.meta.get(META_KEYS.historyId) as string | undefined

test('nothing runs before the first full scan has left a cursor', async () => {
  const { gmail, deps } = setup([['a']])

  const result = await runIncrementalSlice(deps())

  assert.deepEqual(gmail.historyCalls, [], 'no cursor means no history query')
  assert.equal(result.processed, 0)
})

test('a completed backfill leaves the cursor it captured before listing', async () => {
  const store = createMemoryStore()
  const gmail = createFakeGmail([['a']], new Map([['a', message('a')]]))
  gmail.profileHistoryId = '5000'

  await runBackfillSlice({ store, gmail, now: () => 0, budget: 10, backfillDays: 45 })

  assert.equal(cursorOf(store), '5000', 'section 6: history can resume from here')
})

test('new mail is discovered and processed from the cursor', async () => {
  const { store, gmail, deps } = setup([['n1', 'n2']])
  await store.setMeta(META_KEYS.historyId, '100')
  gmail.profileHistoryId = '200'

  const result = await runIncrementalSlice(deps())

  assert.deepEqual({ discovered: result.discovered, processed: result.processed }, {
    discovered: 2,
    processed: 2,
  })
  assert.deepEqual(gmail.fullCalls, ['n1', 'n2'])
  assert.equal(store.processed.size, 2)
})

test('the cursor only advances once every discovered message is terminal', async () => {
  const { store, gmail, deps } = setup([['n1', 'n2', 'n3']])
  await store.setMeta(META_KEYS.historyId, '100')
  gmail.profileHistoryId = '200'

  // A budget of one leaves two messages pending.
  const partial = await runIncrementalSlice(deps(1))

  assert.equal(partial.remaining, true)
  assert.equal(cursorOf(store), '100', 'section 6: advancing here would skip new mail')
  assert.deepEqual(jobOf(store)?.pendingMessageIds, ['n2', 'n3'])
  assert.equal(jobOf(store)?.targetHistoryId, '200', 'the target was persisted up front')

  await runIncrementalSlice(deps())

  assert.equal(cursorOf(store), '200', 'committed only after the last message')
  assert.equal(jobOf(store), undefined, 'and the job is cleared')
})

test('a restart resumes the persisted job without re-querying history', async () => {
  const { store, gmail, deps } = setup([['n1', 'n2']])
  await store.setMeta(META_KEYS.historyId, '100')

  await runIncrementalSlice(deps(1))
  const callsAfterFirst = gmail.historyCalls.length

  await runIncrementalSlice(deps())

  assert.equal(gmail.historyCalls.length, callsAfterFirst, 'resume before asking for more')
  assert.deepEqual(gmail.fullCalls, ['n1', 'n2'], 'each message fetched exactly once')
})

test('an empty history still moves the cursor forward', async () => {
  const { store, gmail, deps } = setup([[]])
  await store.setMeta(META_KEYS.historyId, '100')
  gmail.profileHistoryId = '300'

  const result = await runIncrementalSlice(deps())

  assert.equal(result.discovered, 0)
  assert.equal(cursorOf(store), '300', 'otherwise every sync re-walks the same range')
})

test('an expired cursor asks for the routine full re-list rather than failing', async () => {
  const { store, deps, gmail } = setup([['n1']])
  await store.setMeta(META_KEYS.historyId, '100')
  gmail.historyError = new GmailApiError(404, '/history', 'historyId is too old')

  const result = await runIncrementalSlice(deps())

  assert.equal(result.fullSyncRequired, true, 'section 6: normal operation, not recovery')
  assert.equal(cursorOf(store), undefined, 'the dead cursor is dropped')
  assert.equal(jobOf(store), undefined)
})

test('the completion cache keeps the full-list fallback cheap', async () => {
  const store = createMemoryStore()
  const gmail = createFakeGmail([['a']], new Map([['a', message('a')]]))

  await runBackfillSlice({ store, gmail, now: () => 0, budget: 10, backfillDays: 45 })
  const callsAfterFirst = [...gmail.fullCalls]

  // The fallback re-lists the same window; nothing should be refetched.
  await store.setMeta(META_KEYS.backfill, undefined)
  await runBackfillSlice({ store, gmail, now: () => 0, budget: 10, backfillDays: 45 })

  assert.deepEqual(gmail.fullCalls, callsAfterFirst)
})

test('a message already processed is skipped without a Gmail fetch', async () => {
  const { store, gmail, deps } = setup([['n1']])
  await store.setMeta(META_KEYS.historyId, '100')

  await runIncrementalSlice(deps())
  const callsAfterFirst = [...gmail.fullCalls]

  // The same message reappears in a later history page, as Gmail may report it.
  await store.setMeta(META_KEYS.incremental, undefined)
  await store.setMeta(META_KEYS.historyId, '100')
  await runIncrementalSlice(deps())

  assert.deepEqual(gmail.fullCalls, callsAfterFirst)
})

test('history paging collects every page before any message is parsed', async () => {
  const { store, gmail, deps } = setup([['n1'], ['n2'], ['n3']])
  await store.setMeta(META_KEYS.historyId, '100')

  const result = await runIncrementalSlice(deps(1))

  assert.deepEqual(gmail.historyCalls, [null, '1', '2'], 'all pages walked first')
  assert.equal(result.discovered, 3)
  assert.equal(gmail.fullCalls.length, 1, 'but only one message parsed under the budget')
})

test('a transient failure schedules a retry instead of losing the message', async () => {
  const { store, gmail, deps } = setup([['n1', 'n2']])
  await store.setMeta(META_KEYS.historyId, '100')
  gmail.failing.add('n1')

  const result = await runIncrementalSlice(deps())

  assert.equal(result.remaining, true)
  assert.ok((result.nextAttemptAt ?? 0) > 1_000_000, 'backed off into the future')
  assert.equal(store.processed.has('n1'), false, 'never marked processed before it succeeds')
  assert.deepEqual(jobOf(store)?.pendingMessageIds, ['n1', 'n2'], 'the head is not dropped')
  assert.equal(cursorOf(store), '100', 'and the cursor stays put')
})

test('a scheduled retry is honoured before the next attempt', async () => {
  const { store, gmail, deps } = setup([['n1']])
  await store.setMeta(META_KEYS.historyId, '100')
  gmail.failing.add('n1')

  await runIncrementalSlice(deps())
  const callsAfterFailure = gmail.fullCalls.length

  const blocked = await runIncrementalSlice(deps())

  assert.equal(gmail.fullCalls.length, callsAfterFailure, 'waited rather than hammering Gmail')
  assert.equal(blocked.remaining, true)
})

test('a permanently broken message is recorded and the cursor still advances', async () => {
  const { store, gmail, deps } = setup([['n1', 'n2']])
  await store.setMeta(META_KEYS.historyId, '100')
  gmail.profileHistoryId = '200'
  gmail.failing.add('n1')

  // Four attempts exhaust the retry cap; each wake is past the previous backoff.
  let clock = 1_000_000
  const advancing = (): BackfillDeps => ({
    ...deps(),
    now: () => (clock += 10 * 60_000),
  })

  for (let attempt = 0; attempt < 4; attempt += 1) await runIncrementalSlice(advancing())

  assert.equal(store.processed.get('n1')?.status, 'failed')
  assert.equal(store.processed.get('n2')?.status, 'candidates', 'the scan moved past it')
  assert.equal(cursorOf(store), '200', 'a terminal failure still counts as terminal')
})

function historyOnlyGmail(): FakeGmail {
  const gmail = createFakeGmail([[]], new Map())
  gmail.historyPages = [[]]
  return gmail
}

test('a cursor that cannot be read leaves the mailbox untouched', async () => {
  const store = createMemoryStore()
  const gmail = historyOnlyGmail()
  gmail.historyError = new GmailApiError(500, '/history', 'server error')
  await store.setMeta(META_KEYS.historyId, '100')

  await assert.rejects(() =>
    runIncrementalSlice({ store, gmail, now: () => 0, budget: 10, backfillDays: 45 }),
  )
  assert.equal(cursorOf(store), '100', 'a 5xx must not look like an expired cursor')
})
