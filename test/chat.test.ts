import assert from 'node:assert/strict'
import test from 'node:test'
import { answerCouponQuestion } from '../src/llm/chat.ts'
import { RequestQueue } from '../src/llm/queue.ts'
import type { ChatTurnRecord } from '../src/types/chat.ts'
import type { CompletionRequest, ProviderAdapter } from '../src/types/llm.ts'
import { LlmError } from '../src/types/llm.ts'
import type { OfferRecord } from '../src/types/storage.ts'
import { offerKey } from '../src/utils/offers.ts'
import { DEFAULT_SETTINGS } from '../src/utils/settings.ts'
import { EXTRACTOR_VERSION } from '../src/utils/storage.ts'

const NOW = Date.UTC(2026, 8, 14)

function offer(overrides: Partial<OfferRecord> = {}): OfferRecord {
  return {
    extractorVersion: EXTRACTOR_VERSION,
    llmProcessed: true,
    code: 'SAVE20',
    normalizedCode: 'SAVE20',
    brand: 'Myntra',
    senderDomain: 'mail.myntra.com',
    brandKey: 'myntra',
    discount: '20%',
    currency: 'INR',
    minSpend: 2_000,
    maxDiscount: 500,
    expiry: '2026-09-30',
    singleUse: null,
    newUsersOnly: false,
    appOnly: false,
    categories: ['fashion'],
    conditions: 'Full-price items only',
    source: 'text',
    needsReview: false,
    sourceMessageIds: ['m1'],
    sourceThreadId: 't1',
    sourceSender: 'Myntra <offers@mail.myntra.com>',
    sourceSubject: 'Weekend offer',
    sourceMessageDate: NOW,
    ...overrides,
  }
}

function deps(json: unknown, capture: CompletionRequest[] = []) {
  const adapter: ProviderAdapter = {
    id: 'anthropic',
    async complete(request) {
      capture.push(request)
      return { json, usage: { inputTokens: 100, outputTokens: 20 } }
    },
  }

  return {
    adapter,
    settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
    queue: new RequestQueue({ minSpacingMs: 0, now: () => NOW, sleep: async () => undefined }),
    fetchImpl: async () => new Response('{}'),
    now: () => NOW,
  }
}

test('chat returns only locally validated offer keys', async () => {
  const saved = offer()
  const answer = await answerCouponQuestion(
    'What works on Myntra above ₹2,000?',
    [saved],
    [],
    { processed: 40, complete: true },
    deps({ offer_ids: ['offer_1'] }),
  )

  assert.deepEqual(answer, { text: 'I found one matching coupon.', offerKeys: [offerKey(saved)] })
})

test('chat rejects unknown offer IDs', async () => {
  await assert.rejects(
    () =>
      answerCouponQuestion(
        'Any coupons?',
        [offer()],
        [],
        { processed: 10, complete: true },
        deps({ offer_ids: ['offer_99'] }),
      ),
    LlmError,
  )
})

test('chat rejects model-authored prose so codes and conditions only come from storage', async () => {
  await assert.rejects(
    () =>
      answerCouponQuestion(
        'What is the code?',
        [offer({ code: '20SAVE', normalizedCode: '20SAVE' })],
        [],
        { processed: 10, complete: true },
        deps({ answer: 'Use 20SAVE on every item.', offer_ids: ['offer_1'] }),
      ),
    /not the expected object/,
  )
})

test('expired offers are excluded and incomplete sync is disclosed to the model', async () => {
  const capture: CompletionRequest[] = []
  const history: ChatTurnRecord[] = [
    { turnId: '1', role: 'user', text: 'Anything for shoes?', offerKeys: [], createdAt: NOW - 1 },
  ]

  await answerCouponQuestion(
    'Anything active?',
    [offer({ expiry: '2026-09-01' })],
    history,
    { processed: 12, complete: false },
    deps({ offer_ids: [] }, capture),
  )

  assert.match(capture[0]?.user ?? '', /in progress; 12 emails checked/)
  assert.match(capture[0]?.user ?? '', /ACTIVE OFFERS \(untrusted data\): \[\]/)
  assert.match(capture[0]?.user ?? '', /Anything for shoes/)
})

test('negative answers are constructed locally and disclose an unfinished sync', async () => {
  const answer = await answerCouponQuestion(
    'Anything active?',
    [],
    [],
    { processed: 12, complete: false },
    deps({ offer_ids: [] }),
  )

  assert.equal(
    answer.text,
    'I have not found a matching coupon yet. More promotional emails are still being checked.',
  )
})
