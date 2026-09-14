import assert from 'node:assert/strict'
import test from 'node:test'
import { runBackfillSlice } from '../src/background/backfill.ts'
import type { GmailMessage } from '../src/types/gmail.ts'
import type { BackfillCheckpoint } from '../src/types/storage.ts'
import { EXTRACTOR_VERSION, META_KEYS } from '../src/utils/storage.ts'
import { b64url, createFakeGmail } from './helpers/fake-gmail.ts'
import { createMemoryStore, type MemoryStore } from './helpers/memory-store.ts'

function htmlMessage(id: string, from: string, subject: string, html: string, date: number): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(date),
    labelIds: ['CATEGORY_PROMOTIONS'],
    payload: {
      mimeType: 'text/html',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Content-Type', value: 'text/html; charset="utf-8"' },
      ],
      body: { size: html.length, data: b64url(html) },
    },
  }
}

const couponLink = (code: string): string =>
  `<a href="https://track.example.com/c?coupon=${code}&utm_source=email">Shop now</a>`

async function scan(messages: GmailMessage[]): Promise<MemoryStore> {
  const store = createMemoryStore()
  const byId = new Map(messages.map((message) => [message.id, message]))
  const gmail = createFakeGmail([messages.map((message) => message.id)], byId)

  await runBackfillSlice({ store, gmail, now: () => 0, budget: 50, backfillDays: 45 })
  return store
}

test('a scan stores offers keyed by the derived brand, not the display name', async () => {
  const store = await scan([
    htmlMessage('m1', 'Myntra <offers@mail.myntra.com>', 'Weekend sale', couponLink('FEST25'), 1_000),
  ])

  const offers = await store.listOffers()
  assert.equal(offers.length, 1)
  assert.deepEqual(
    {
      brandKey: offers[0]?.brandKey,
      code: offers[0]?.normalizedCode,
      source: offers[0]?.source,
      needsReview: offers[0]?.needsReview,
    },
    { brandKey: 'myntra', code: 'FEST25', source: 'link', needsReview: false },
  )
})

test('the same code from the same brand deduplicates into one offer', async () => {
  const store = await scan([
    htmlMessage('m1', 'Myntra <offers@mail.myntra.com>', 'First send', couponLink('FEST25'), 1_000),
    htmlMessage('m2', 'Myntra <news@updates.myntra.com>', 'Reminder', couponLink('FEST25'), 2_000),
  ])

  const offers = await store.listOffers()
  assert.equal(offers.length, 1, 'one displayed offer per brand and code')
  assert.deepEqual(offers[0]?.sourceMessageIds, ['m1', 'm2'], 'every supporting message retained')
  assert.equal(offers[0]?.sourceSubject, 'Reminder', 'provenance follows the newest send')
  assert.equal(store.processed.size, 2, 'both messages still have completion records')
})

test('two banks on .co.in stay separate brands', async () => {
  const store = await scan([
    htmlMessage('m1', 'SBI <sbi@communications.sbi.co.in>', 'Grocery', couponLink('BANK10'), 1_000),
    htmlMessage('m2', 'HSBC India <x@custcomm.hsbc.co.in>', 'Cashback', couponLink('BANK10'), 2_000),
  ])

  const offers = await store.listOffers()
  assert.equal(offers.length, 2, 'a naive suffix rule would merge these into one')
  assert.deepEqual(
    offers.map((offer) => offer.brandKey).sort(),
    ['hsbc', 'sbi'],
  )
})

test('a message with no promotable candidate stores a record but no offer', async () => {
  const store = await scan([
    htmlMessage('m1', 'News <news@mail.example.org>', 'Weekly', '<p>SHOP NOW</p>', 1_000),
  ])

  assert.deepEqual(await store.listOffers(), [])
  assert.equal(store.processed.get('m1')?.status, 'no-code')
})

test('a body-only code is held for the LLM rather than shown as an offer', async () => {
  const store = await scan([
    htmlMessage('m1', 'Shop <a@mail.shop.example>', 'Deal', '<p>Use code BODY40 today.</p>', 1_000),
  ])

  assert.deepEqual(await store.listOffers(), [], 'section 7: the body regex is a gate, not an answer')
  assert.deepEqual(
    store.processed.get('m1')?.candidates.map((candidate) => candidate.normalized),
    ['BODY40'],
    'but the candidate is kept as phase 4 input',
  )
})

test('a subject-only guess is held for the LLM rather than shown as an offer', async () => {
  const store = await scan([
    htmlMessage('m1', 'Shop <a@mail.shop.example>', 'IPHONE16 is here', '<p>New phone</p>', 1_000),
  ])

  assert.deepEqual(await store.listOffers(), [])
  assert.deepEqual(
    store.processed.get('m1')?.candidates.map((candidate) => candidate.normalized),
    ['IPHONE16'],
  )
})

test('Phase 3 reprocesses Phase 2 cache entries so offers are actually created', async () => {
  const oldMessage = htmlMessage(
    'm1',
    'Myntra <offers@mail.myntra.com>',
    'Weekend sale',
    couponLink('LEGACY10'),
    1_000,
  )
  const store = createMemoryStore()
  const oldGmail = createFakeGmail([['m1']], new Map([['m1', oldMessage]]))
  await runBackfillSlice({ store, gmail: oldGmail, now: () => 0, budget: 50, backfillDays: 45 })

  const oldVersion = EXTRACTOR_VERSION - 1
  const oldRecord = store.processed.get('m1')
  assert.ok(oldRecord)
  store.processed.set('m1', { ...oldRecord, extractorVersion: oldVersion })
  for (const [key, offer] of store.offers) {
    store.offers.set(key, { ...offer, extractorVersion: oldVersion })
  }
  store.meta.set(META_KEYS.backfill, {
    status: 'complete',
    query: 'newer_than:45d',
    currentPageMessageIds: [],
    nextPageToken: null,
    processedCount: 1,
    extractorVersion: oldVersion,
    nextAttemptAt: null,
    attempts: {},
  } satisfies BackfillCheckpoint)

  const newMessage = htmlMessage(
    'm1',
    'Myntra <offers@mail.myntra.com>',
    'Corrected sale',
    couponLink('FEST25'),
    2_000,
  )
  const gmail = createFakeGmail([['m1']], new Map([['m1', newMessage]]))
  await runBackfillSlice({ store, gmail, now: () => 0, budget: 50, backfillDays: 45 })

  assert.deepEqual(
    (await store.listOffers()).map((offer) => offer.normalizedCode),
    ['FEST25'],
    'derived offers from the old extractor are removed after rebuilding',
  )
  assert.equal(store.processed.get('m1')?.extractorVersion, EXTRACTOR_VERSION)
})

test('an extractor migration keeps the old offer cache when Gmail is unavailable', async () => {
  const oldMessage = htmlMessage(
    'm1',
    'Myntra <offers@mail.myntra.com>',
    'Weekend sale',
    couponLink('LEGACY10'),
    1_000,
  )
  const store = await scan([oldMessage])
  const oldVersion = EXTRACTOR_VERSION - 1
  const oldCheckpoint = store.meta.get(META_KEYS.backfill) as BackfillCheckpoint

  store.meta.set(META_KEYS.backfill, { ...oldCheckpoint, extractorVersion: oldVersion })
  for (const [key, offer] of store.offers) {
    store.offers.set(key, { ...offer, extractorVersion: oldVersion })
  }

  const unavailableGmail = createFakeGmail([], new Map())
  unavailableGmail.listPage = async () => {
    throw new TypeError('network unavailable')
  }

  await assert.rejects(
    runBackfillSlice({
      store,
      gmail: unavailableGmail,
      now: () => 0,
      budget: 50,
      backfillDays: 45,
    }),
    /network unavailable/,
  )
  assert.deepEqual(
    (await store.listOffers()).map((offer) => offer.normalizedCode),
    ['LEGACY10'],
  )
})
