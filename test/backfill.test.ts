import assert from 'node:assert/strict'
import test from 'node:test'
import { runBackfillSlice } from '../src/background/backfill.ts'
import { GmailApiError } from '../src/background/gmail.ts'
import type { BackfillDeps } from '../src/types/backfill.ts'
import type { GmailMessage } from '../src/types/gmail.ts'
import type { BackfillCheckpoint } from '../src/types/storage.ts'
import { EXTRACTOR_VERSION, META_KEYS } from '../src/utils/storage.ts'
import {
  b64url,
  createFakeGmail,
  externalizedHtmlMessage,
  textMessage,
} from './helpers/fake-gmail.ts'
import { createMemoryStore, type MemoryStore } from './helpers/memory-store.ts'

const WITH_CODE = 'Weekend treat. Use code SAVE20 at checkout.'
const WITHOUT_CODE = 'Our new season collection has landed in stores.'

function setup(pages: string[][], bodies: Record<string, string> = {}) {
  const messages = new Map<string, GmailMessage>()
  for (const id of pages.flat()) {
    messages.set(id, textMessage(id, bodies[id] ?? WITH_CODE))
  }

  const store = createMemoryStore()
  const gmail = createFakeGmail(pages, messages)

  const deps = (budget: number): BackfillDeps => ({
    store,
    gmail,
    now: () => 1_757_600_000_000,
    budget,
    backfillDays: 45,
  })

  return { store, gmail, messages, deps }
}

const checkpointOf = (store: MemoryStore): BackfillCheckpoint =>
  store.meta.get(META_KEYS.backfill) as BackfillCheckpoint

test('processes a page, gating each message and committing one record per message', async () => {
  const { store, deps } = setup([['a', 'b']], { b: WITHOUT_CODE })

  const result = await runBackfillSlice(deps(10))

  assert.deepEqual(
    { processed: result.processed, remaining: result.remaining },
    { processed: 2, remaining: false },
  )
  assert.equal(store.commits, 2, 'one atomic transaction per message')
  assert.equal(store.processed.get('a')?.status, 'candidates')
  assert.deepEqual(store.processed.get('a')?.candidates.map((c) => c.normalized), ['SAVE20'])
  assert.equal(store.processed.get('b')?.status, 'no-code')
  assert.equal(checkpointOf(store).status, 'complete')
})

test('a budget stops the slice mid-page and leaves the remainder checkpointed', async () => {
  const { store, gmail, deps } = setup([['a', 'b', 'c', 'd']])

  const result = await runBackfillSlice(deps(2))

  assert.equal(result.processed, 2)
  assert.equal(result.remaining, true)
  assert.deepEqual(gmail.fullCalls, ['a', 'b'], 'did not fetch beyond the budget')
  assert.deepEqual(checkpointOf(store).currentPageMessageIds, ['c', 'd'])
})

test('a worker restart resumes mid-page from the store alone, refetching nothing', async () => {
  const { store, gmail, deps } = setup([['a', 'b', 'c', 'd']])

  await runBackfillSlice(deps(2))
  // Every runner local is discarded here; only the store survives, exactly as
  // it would when Chrome stops an idle MV3 service worker.
  const resumed = await runBackfillSlice(deps(10))

  assert.equal(resumed.processed, 2)
  assert.deepEqual(gmail.fullCalls, ['a', 'b', 'c', 'd'], 'each message fetched exactly once')
  assert.equal(store.processed.size, 4)
  assert.equal(checkpointOf(store).status, 'complete')
})

test('a restart after message commit uses the completion cache instead of refetching', async () => {
  const { store, gmail, deps } = setup([['a', 'b']])
  const setMeta = store.setMeta.bind(store)
  let interruptOnce = true

  store.setMeta = async (key, value) => {
    const checkpoint = value as BackfillCheckpoint
    if (interruptOnce && key === META_KEYS.backfill && checkpoint.processedCount === 1) {
      interruptOnce = false
      throw new Error('worker stopped before checkpoint update')
    }
    await setMeta(key, value)
  }

  await assert.rejects(runBackfillSlice(deps(10)), /worker stopped/)
  assert.equal(store.processed.has('a'), true, 'message transaction committed first')
  assert.deepEqual(checkpointOf(store).currentPageMessageIds, ['a', 'b'])

  const resumed = await runBackfillSlice(deps(10))

  assert.equal(resumed.skipped, 1)
  assert.deepEqual(gmail.fullCalls, ['a', 'b'], 'the committed message was not fetched twice')
  assert.equal(checkpointOf(store).status, 'complete')
})

test('the page token advances only after every ID in the page is terminal', async () => {
  const { store, gmail, deps } = setup([['a', 'b'], ['c', 'd']])

  await runBackfillSlice(deps(1))
  assert.deepEqual(gmail.listCalls, [null], 'no second page while the first is unfinished')
  assert.equal(checkpointOf(store).nextPageToken, '1')

  await runBackfillSlice(deps(1))
  assert.deepEqual(gmail.listCalls, [null], 'still on page one')

  await runBackfillSlice(deps(10))
  assert.deepEqual(gmail.listCalls, [null, '1'], 'second page fetched only once page one drained')
  assert.equal(store.processed.size, 4)
})

test('the completion cache skips already-processed messages without a Gmail call', async () => {
  const { store, gmail, deps } = setup([['a', 'b']])

  await runBackfillSlice(deps(10))
  const afterFirst = [...gmail.fullCalls]

  // A full-list fallback re-walks the same window, as section 6 says is routine.
  await store.setMeta(META_KEYS.backfill, undefined)
  const second = await runBackfillSlice(deps(10))

  assert.equal(second.skipped, 2)
  assert.equal(second.processed, 0)
  assert.deepEqual(gmail.fullCalls, afterFirst, 'no message refetched')
  assert.equal(store.commits, 2, 'no redundant writes')
  assert.equal(checkpointOf(store).processedCount, 2, 'cached messages still count as scanned')
})

test('cached messages consume the per-wake budget', async () => {
  const { store, deps } = setup([['a', 'b', 'c']])

  await runBackfillSlice(deps(10))
  await store.setMeta(META_KEYS.backfill, undefined)

  const result = await runBackfillSlice(deps(1))

  assert.equal(result.skipped, 1)
  assert.equal(result.remaining, true)
  assert.equal(checkpointOf(store).processedCount, 1)
  assert.deepEqual(checkpointOf(store).currentPageMessageIds, ['b', 'c'])
})

test('an invalid saved page token restarts the query and uses the completion cache', async () => {
  const { store, gmail, deps } = setup([['a', 'b'], ['c']])

  await runBackfillSlice(deps(2))
  const saved = checkpointOf(store)
  await store.setMeta(META_KEYS.backfill, { ...saved, nextPageToken: 'expired' })

  const listPage = gmail.listPage.bind(gmail)
  gmail.listPage = async (options) => {
    if (options.pageToken === 'expired') {
      gmail.listCalls.push('expired')
      throw new GmailApiError(400, '/messages?pageToken=expired', 'invalid page token')
    }
    return listPage(options)
  }

  const result = await runBackfillSlice(deps(10))

  assert.equal(result.remaining, false)
  assert.deepEqual(gmail.listCalls, [null, 'expired', null, '1'])
  assert.deepEqual(gmail.fullCalls, ['a', 'b', 'c'], 'completed messages were not fetched again')
  assert.equal(checkpointOf(store).processedCount, 3)
})

test('an extractor version bump makes cached results eligible again', async () => {
  const { store, gmail, deps } = setup([['a']])

  await runBackfillSlice(deps(10))
  assert.equal(gmail.fullCalls.length, 1)

  // Simulate a record written by an older extractor.
  const stale = store.processed.get('a')
  assert.ok(stale)
  store.processed.set('a', { ...stale, extractorVersion: EXTRACTOR_VERSION - 1 })
  await store.setMeta(META_KEYS.backfill, undefined)

  const second = await runBackfillSlice(deps(10))

  assert.equal(second.skipped, 0, 'a stale version is not a cache hit')
  assert.equal(second.processed, 1)
  assert.deepEqual(gmail.fullCalls, ['a', 'a'])
  assert.equal(store.processed.get('a')?.extractorVersion, EXTRACTOR_VERSION)
})

test('a failing message is retried across wakes and never marked processed early', async () => {
  const { store, gmail, deps } = setup([['a', 'b']])
  gmail.failing.add('a')
  let currentTime = 1_757_600_000_000

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await runBackfillSlice({ ...deps(10), now: () => currentTime })
    assert.equal(result.processed, 0, 'nothing commits while the head message fails')
    assert.match(result.error ?? '', /Gmail 500 on a/)
    assert.equal(store.processed.has('a'), false, 'never marked processed before it succeeds')
    assert.deepEqual(checkpointOf(store).currentPageMessageIds, ['a', 'b'], 'head is not dropped')
    currentTime = result.nextAttemptAt ?? currentTime
  }

  // Fourth attempt exhausts the cap and records a terminal failure.
  const final = await runBackfillSlice({ ...deps(10), now: () => currentTime })

  assert.equal(store.processed.get('a')?.status, 'failed')
  assert.match(store.processed.get('a')?.error ?? '', /Gmail 500 on a/)
  assert.equal(store.processed.get('b')?.status, 'candidates', 'the scan moved past it')
  assert.equal(final.remaining, false)
})

test('a message that starts failing and then succeeds clears its attempt count', async () => {
  const { store, gmail, deps } = setup([['a']])
  gmail.failing.add('a')

  const first = await runBackfillSlice(deps(10))
  assert.equal(checkpointOf(store).attempts['a'], 1)

  gmail.failing.delete('a')
  await runBackfillSlice({ ...deps(10), now: () => first.nextAttemptAt ?? 0 })

  assert.equal(store.processed.get('a')?.status, 'candidates')
  assert.deepEqual(checkpointOf(store).attempts, {}, 'attempt count cleared on success')
})

test('a temporary fetch failure waits and retries instead of becoming terminal', async () => {
  const { store, gmail, deps } = setup([['a']])
  const getFull = gmail.getFull.bind(gmail)
  let failOnce = true
  let currentTime = 1_000

  gmail.getFull = async (messageId) => {
    if (failOnce) {
      failOnce = false
      throw new TypeError('Failed to fetch')
    }
    return getFull(messageId)
  }

  const first = await runBackfillSlice({ ...deps(10), now: () => currentTime })
  assert.equal(first.nextAttemptAt, 31_000)
  assert.equal(store.processed.has('a'), false)

  const early = await runBackfillSlice({ ...deps(10), now: () => currentTime })
  assert.equal(early.nextAttemptAt, 31_000)
  assert.equal(store.processed.has('a'), false)

  currentTime = 31_000
  await runBackfillSlice({ ...deps(10), now: () => currentTime })
  assert.equal(store.processed.get('a')?.status, 'candidates')
})

test('a permission error stops the slice without poisoning the completion cache', async () => {
  const { store, gmail, deps } = setup([['a']])
  gmail.getFull = async () => {
    throw new GmailApiError(403, '/messages/a', 'forbidden')
  }

  await assert.rejects(runBackfillSlice(deps(10)), /Gmail 403/)

  assert.equal(store.processed.has('a'), false)
  assert.deepEqual(checkpointOf(store).attempts, {})
  assert.deepEqual(checkpointOf(store).currentPageMessageIds, ['a'])
})

test('a message removed from Promotions after listing is ignored', async () => {
  const { store, messages, deps } = setup([['a']])
  messages.set('a', { ...messages.get('a')!, labelIds: ['INBOX'] })

  await runBackfillSlice(deps(10))

  assert.equal(store.processed.get('a')?.status, 'ignored')
  assert.deepEqual(store.processed.get('a')?.candidates, [])
})

test('an externalized body is fetched and gated, not silently skipped', async () => {
  const store = createMemoryStore()
  const messages = new Map([['big', externalizedHtmlMessage('big', 'att-1')]])
  const gmail = createFakeGmail([['big']], messages)
  gmail.attachments.set('att-1', b64url('<p>Use code LARGE40 this week.</p>'))

  await runBackfillSlice({
    store,
    gmail,
    now: () => 0,
    budget: 10,
    backfillDays: 45,
  })

  assert.deepEqual(gmail.attachmentCalls, ['att-1'])
  assert.equal(store.processed.get('big')?.status, 'candidates')
  assert.deepEqual(store.processed.get('big')?.candidates.map((c) => c.normalized), ['LARGE40'])
})

test('an empty Promotions window completes instead of looping', async () => {
  const { store, deps } = setup([[]])

  const result = await runBackfillSlice(deps(10))

  assert.deepEqual(
    { processed: result.processed, remaining: result.remaining },
    { processed: 0, remaining: false },
  )
  assert.equal(checkpointOf(store).status, 'complete')
})

test('a completed backfill does no further work', async () => {
  const { store, gmail, deps } = setup([['a']])

  await runBackfillSlice(deps(10))
  const callsAfterFirst = gmail.fullCalls.length
  const result = await runBackfillSlice(deps(10))

  assert.deepEqual(result, { processed: 0, skipped: 0, withCandidates: 0, remaining: false })
  assert.equal(gmail.fullCalls.length, callsAfterFirst)
  assert.equal(store.commits, 1)
})

test('a run of empty pages cannot spin without bound', { timeout: 5000 }, async () => {
  const store = createMemoryStore()
  let listCalls = 0

  const result = await runBackfillSlice({
    store,
    now: () => 0,
    budget: 15,
    backfillDays: 45,
    gmail: {
      async listPage() {
        listCalls += 1
        // An empty page that still claims more to come examines no message, so
        // the message budget alone never ends the loop.
        return { ids: [], nextPageToken: 'always-more' }
      },
      async getFull() {
        throw new Error('no message should be fetched')
      },
      async getAttachmentData() {
        return ''
      },
    },
  })

  assert.equal(listCalls, 10, 'page fetches are capped per slice')
  assert.equal(result.processed, 0)
  assert.equal(result.remaining, true, 'the next wake continues rather than giving up')
})
