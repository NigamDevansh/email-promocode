import assert from 'node:assert/strict'
import test from 'node:test'
import { runBackfillSlice } from '../src/background/backfill.ts'
import { RequestQueue } from '../src/llm/queue.ts'
import type { BackfillDeps } from '../src/types/backfill.ts'
import type { GmailMessage } from '../src/types/gmail.ts'
import {
  LlmError,
  type CompletionResult,
  type ExtractionDeps,
  type ProviderAdapter,
} from '../src/types/llm.ts'
import { DEFAULT_SETTINGS } from '../src/utils/settings.ts'
import { META_KEYS } from '../src/utils/storage.ts'
import { b64url, createFakeGmail } from './helpers/fake-gmail.ts'
import { createMemoryStore, type MemoryStore } from './helpers/memory-store.ts'

/** A code stated only in body prose: phase 3 holds it back, phase 4 confirms it. */
const BODY_ONLY = '<p>Flat 20% off. Use code BODY40 before Sunday. Min spend 2000.</p>'
const LINK_ONLY = '<a href="https://shop.example/deal?coupon=LINK10">Shop now</a>'

function message(html: string, id: string = 'm1'): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(Date.UTC(2026, 8, 13)),
    labelIds: ['CATEGORY_PROMOTIONS'],
    payload: {
      mimeType: 'text/html',
      headers: [
        { name: 'From', value: 'Myntra <offers@mail.myntra.com>' },
        { name: 'Subject', value: 'Weekend offer' },
        { name: 'Content-Type', value: 'text/html; charset="utf-8"' },
      ],
      body: { size: html.length, data: b64url(html) },
    },
  }
}

function adapterReturning(result: CompletionResult | (() => never)): ProviderAdapter {
  return {
    id: 'anthropic',
    async complete() {
      if (typeof result === 'function') result()
      return result as CompletionResult
    },
  }
}

function llmDeps(adapter: ProviderAdapter): ExtractionDeps {
  return {
    adapter,
    settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', model: 'test-model' },
    queue: new RequestQueue({ minSpacingMs: 0, now: () => 0, sleep: async () => undefined }),
    fetchImpl: async () => new Response('{}'),
  }
}

async function scan(html: string, llm?: ExtractionDeps): Promise<MemoryStore> {
  const store = createMemoryStore()
  const gmail = createFakeGmail([['m1']], new Map([['m1', message(html)]]))

  const deps: BackfillDeps = {
    store,
    gmail,
    now: () => 0,
    random: () => 0.5,
    budget: 10,
    backfillDays: 45,
    ...(llm ? { llm } : {}),
  }
  await runBackfillSlice(deps)
  return store
}

const GOOD_RESULT: CompletionResult = {
  json: {
    offers: [
      {
        code: 'BODY40',
        discount: '20%',
        currency: 'INR',
        min_spend: 2000,
        max_discount: null,
        expiry: '2026-09-20',
        single_use: null,
        new_users_only: false,
        app_only: false,
        categories: [],
        conditions: 'Weekend only',
      },
    ],
  },
  usage: { inputTokens: 2400, outputTokens: 180 },
}

test('without a configured provider a body-only code stays unpromoted', async () => {
  const store = await scan(BODY_ONLY)

  assert.deepEqual(await store.listOffers(), [])
  assert.equal(store.processed.get('m1')?.status, 'candidates')
})

test('with a provider the same code becomes an offer with its details filled in', async () => {
  const store = await scan(BODY_ONLY, llmDeps(adapterReturning(GOOD_RESULT)))

  const [offer] = await store.listOffers()
  assert.equal(offer?.normalizedCode, 'BODY40')
  assert.equal(offer?.discount, '20%')
  assert.equal(offer?.currency, 'INR')
  assert.equal(offer?.minSpend, 2000)
  assert.equal(offer?.expiry, '2026-09-20')
  assert.equal(offer?.needsReview, false, 'the model confirmed it against the candidate list')
  assert.deepEqual(store.processed.get('m1')?.llmUsage, GOOD_RESULT.usage)
})

test('a code the model invented is never stored', async () => {
  const invented: CompletionResult = {
    json: { offers: [{ ...(GOOD_RESULT.json as { offers: object[] }).offers[0], code: 'GHOST99' }] },
    usage: { inputTokens: 10, outputTokens: 10 },
  }

  const store = await scan(BODY_ONLY, llmDeps(adapterReturning(invented)))

  assert.deepEqual(await store.listOffers(), [], 'section 11: rejected before it can be displayed')
  assert.equal(store.processed.get('m1')?.status, 'candidates', 'the message is still complete')
})

test('a message with no candidates never reaches the provider', async () => {
  let calls = 0
  const adapter: ProviderAdapter = {
    id: 'anthropic',
    async complete() {
      calls += 1
      return GOOD_RESULT
    },
  }

  const store = await scan('<p>Our new collection has landed.</p>', llmDeps(adapter))

  assert.equal(calls, 0, 'section 7: the gate stops a no-code message before any token is spent')
  assert.equal(store.processed.get('m1')?.status, 'no-code')
})

test('an auth error stops the slice instead of poisoning the completion cache', async () => {
  const adapter = adapterReturning(() => {
    throw new LlmError('auth', 'invalid x-api-key', 401)
  })

  await assert.rejects(() => scan(BODY_ONLY, llmDeps(adapter)), /invalid x-api-key/)
})

test('a refusal is terminal for that message but leaves the free-path result', async () => {
  const adapter = adapterReturning(() => {
    throw new LlmError('refusal', 'model declined')
  })

  const store = await scan(BODY_ONLY, llmDeps(adapter))

  assert.equal(store.processed.get('m1')?.status, 'failed', 'recorded, not retried forever')
  assert.match(store.processed.get('m1')?.error ?? '', /model declined/)
})

test('a terminal LLM failure preserves a direct link offer', async () => {
  const adapter = adapterReturning(() => {
    throw new LlmError('refusal', 'model declined')
  })

  const store = await scan(LINK_ONLY, llmDeps(adapter))
  const [offer] = await store.listOffers()

  assert.equal(offer?.normalizedCode, 'LINK10')
  assert.equal(offer?.source, 'link')
  assert.equal(offer?.llmProcessed, true, 'the terminal attempt must not trigger another paid call')
})

test('a rate limit is retried rather than recorded as a failure', async () => {
  const adapter = adapterReturning(() => {
    throw new LlmError('rate-limit', 'slow down', 429, 120_000)
  })

  const store = await scan(BODY_ONLY, llmDeps(adapter))

  assert.equal(store.processed.has('m1'), false, 'section 6: never marked processed before success')
  const checkpoint = store.meta.get(META_KEYS.backfill) as { nextAttemptAt: number }
  assert.equal(checkpoint.nextAttemptAt, 120_000, 'provider reset survives a worker restart')
})

test('candidate records from a completed keyless scan receive their first LLM pass', async () => {
  const store = createMemoryStore()
  const gmail = createFakeGmail([['m1']], new Map([['m1', message(BODY_ONLY)]]))
  const base: BackfillDeps = {
    store,
    gmail,
    now: () => 0,
    budget: 10,
    backfillDays: 45,
  }

  await runBackfillSlice(base)
  assert.equal(store.processed.get('m1')?.llmProcessed, false)
  assert.deepEqual(await store.listOffers(), [])

  await runBackfillSlice({ ...base, llm: llmDeps(adapterReturning(GOOD_RESULT)) })

  assert.equal(store.processed.get('m1')?.llmProcessed, true)
  assert.equal((await store.listOffers())[0]?.normalizedCode, 'BODY40')
})

test('an LLM rejection removes a free-path offer from the completed keyless scan', async () => {
  const store = createMemoryStore()
  const gmail = createFakeGmail([['m1']], new Map([['m1', message(LINK_ONLY)]]))
  const base: BackfillDeps = {
    store,
    gmail,
    now: () => 0,
    random: () => 0.5,
    budget: 10,
    backfillDays: 45,
  }

  await runBackfillSlice(base)
  assert.equal((await store.listOffers())[0]?.llmProcessed, false)

  await runBackfillSlice({
    ...base,
    llm: llmDeps(adapterReturning({ json: { offers: [] }, usage: GOOD_RESULT.usage })),
  })

  assert.deepEqual(await store.listOffers(), [])
  assert.equal(store.processed.get('m1')?.llmProcessed, true)
})

test('an HTTP content-schema failure is terminal for one message', async () => {
  const adapter = adapterReturning(() => {
    throw new LlmError('schema', 'content could not be processed', 400)
  })

  const store = await scan(BODY_ONLY, llmDeps(adapter))

  assert.equal(store.processed.get('m1')?.status, 'failed')
  assert.match(store.processed.get('m1')?.error ?? '', /content could not be processed/)
})

test('a settings change stops the slice before another provider request starts', async () => {
  let active = true
  let calls = 0
  const adapter: ProviderAdapter = {
    id: 'anthropic',
    async complete() {
      calls += 1
      active = false
      return GOOD_RESULT
    },
  }
  const store = createMemoryStore()
  const gmail = createFakeGmail(
    [['m1', 'm2']],
    new Map([
      ['m1', message(BODY_ONLY, 'm1')],
      ['m2', message(BODY_ONLY, 'm2')],
    ]),
  )

  const result = await runBackfillSlice({
    store,
    gmail,
    now: () => 0,
    random: () => 0.5,
    shouldContinue: () => active,
    budget: 10,
    backfillDays: 45,
    llm: llmDeps(adapter),
  })

  assert.equal(calls, 1)
  assert.equal(result.remaining, true)
  assert.equal(store.processed.has('m2'), false)
})
