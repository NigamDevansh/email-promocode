import assert from 'node:assert/strict'
import test from 'node:test'
import { runBackfillSlice } from '../src/background/backfill.ts'
import type { BackfillDeps, OcrReader } from '../src/types/backfill.ts'
import type { GmailMessage, GmailPart } from '../src/types/gmail.ts'
import type { OcrRun } from '../src/types/ocr.ts'
import { RequestQueue } from '../src/llm/queue.ts'
import type { CompletionResult, ExtractionDeps, ProviderAdapter } from '../src/types/llm.ts'
import { DEFAULT_SETTINGS } from '../src/utils/settings.ts'
import { b64url, createFakeGmail } from './helpers/fake-gmail.ts'
import { createMemoryStore, type MemoryStore } from './helpers/memory-store.ts'

/** The same banner, inlined by the sender instead of hosted on a CDN. */
const INLINE_BANNER: GmailPart = {
  mimeType: 'multipart/related',
  parts: [
    { mimeType: 'image/jpeg', filename: 'hero.jpg', body: { attachmentId: 'att-1', size: 90_000 } },
  ],
}

/** An image-only banner: nothing in the text stages, a hero image worth reading. */
const IMAGE_ONLY =
  '<p>Monsoon Sale is live.</p>' +
  '<img src="https://cdn.myntra.com/hero.jpg" width="600" height="400" alt="Monsoon Sale">'

/** Same email, but the code is already in the body text. */
const TEXT_AND_IMAGE =
  '<p>Use code RAKE25 at checkout.</p>' +
  '<img src="https://cdn.myntra.com/hero.jpg" width="600" height="400" alt="Monsoon Sale">'

function message(html: string, parts?: GmailPart): GmailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    internalDate: String(Date.UTC(2026, 8, 13)),
    labelIds: ['CATEGORY_PROMOTIONS'],
    payload: {
      mimeType: 'text/html',
      headers: [
        { name: 'From', value: 'Myntra <offers@mail.myntra.com>' },
        { name: 'Subject', value: 'Monsoon Sale' },
        { name: 'Content-Type', value: 'text/html; charset="utf-8"' },
      ],
      body: { size: html.length, data: b64url(html) },
      ...(parts ? { parts: parts.parts } : {}),
    },
  }
}

function reader(text: string): { ocr: OcrReader; calls: number } {
  const state = { calls: 0, ocr: null as unknown as OcrReader }
  state.ocr = async (candidates): Promise<OcrRun> => {
    state.calls += 1
    return {
      imagesConsidered: candidates.length,
      imagesRead: 1,
      imagesAccepted: text ? 1 : 0,
      meanConfidence: text ? 92 : 30,
      text,
    }
  }
  return state as { ocr: OcrReader; calls: number }
}

/** Confirms whatever code the candidate list already contains. */
function confirming(code: string, seenPrompts?: string[]): ExtractionDeps {
  const adapter: ProviderAdapter = {
    id: 'anthropic',
    async complete(request): Promise<CompletionResult> {
      seenPrompts?.push(request.user)
      return {
        json: {
          offers: [
            {
              code,
              discount: '25%',
              currency: null,
              min_spend: null,
              max_discount: null,
              expiry: null,
              single_use: null,
              new_users_only: false,
              app_only: false,
              categories: [],
              conditions: '',
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 20 },
      }
    },
  }

  return {
    adapter,
    settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', model: 'test-model' },
    queue: new RequestQueue({ minSpacingMs: 0, now: () => 0, sleep: async () => undefined }),
    fetchImpl: async () => new Response('{}'),
  }
}

interface ScanOptions {
  ocr?: OcrReader
  llm?: ExtractionDeps
  /** Inline image parts served through Gmail. */
  parts?: GmailPart
}

async function scan(html: string, options: ScanOptions = {}): Promise<MemoryStore> {
  const store = createMemoryStore()
  const { ocr, llm, parts } = options
  const deps: BackfillDeps = {
    store,
    gmail: createFakeGmail([['m1']], new Map([['m1', message(html, parts)]])),
    now: () => 0,
    budget: 10,
    backfillDays: 45,
    ...(ocr ? { ocr } : {}),
    ...(llm ? { llm } : {}),
  }
  await runBackfillSlice(deps)
  return store
}

test('a code readable only from the banner becomes an offer', async () => {
  const store = await scan(IMAGE_ONLY, {
    parts: INLINE_BANNER,
    ocr: reader('USE CODE RAKE25 FOR 25% OFF').ocr,
    llm: confirming('RAKE25'),
  })

  const [offer] = await store.listOffers()
  assert.equal(offer?.normalizedCode, 'RAKE25')
  assert.equal(offer?.source, 'ocr', 'section 9: the source records how it was read')
})

test('an OCR-derived code is always flagged for review', async () => {
  const store = await scan(IMAGE_ONLY, {
    parts: INLINE_BANNER,
    ocr: reader('USE CODE RAKE25 FOR 25% OFF').ocr,
    llm: confirming('RAKE25'),
  })

  const [offer] = await store.listOffers()
  assert.equal(
    offer?.needsReview,
    true,
    'section 11: OCR-derived codes are never shown as verified',
  )
})

test('LLM enrichment receives the OCR text that established an image-only offer', async () => {
  const prompts: string[] = []
  await scan('<p>Monsoon Sale is live.</p>', {
    parts: INLINE_BANNER,
    ocr: reader('USE CODE RAKE25 FOR 25% OFF. VALID UNTIL 2026-09-30.').ocr,
    llm: confirming('RAKE25', prompts),
  })

  assert.match(prompts[0] ?? '', /OCR TEXT: USE CODE RAKE25 FOR 25% OFF/)
})

test('the diagnostics record what OCR contributed', async () => {
  const store = await scan(IMAGE_ONLY, {
    parts: INLINE_BANNER,
    ocr: reader('USE CODE RAKE25 FOR 25% OFF').ocr,
  })

  const run = store.processed.get('m1')?.ocr
  assert.equal(run?.imagesRead, 1)
  assert.equal(run?.meanConfidence, 92)
})

test('OCR does not run when the text stages already found a code', async () => {
  const state = reader('USE CODE GHOST99')
  const store = await scan(TEXT_AND_IMAGE, { ocr: state.ocr })

  assert.equal(state.calls, 0, 'section 7: the slowest stage is the last resort')
  assert.deepEqual(
    store.processed.get('m1')?.candidates.map((candidate) => candidate.normalized),
    ['RAKE25'],
    'the text stage found it, so the image was never read',
  )
})

test('OCR does not run when there is no qualifying image', async () => {
  const state = reader('USE CODE RAKE25')
  // A tracking pixel is the only image, and it is filtered before any fetch.
  await scan('<p>New arrivals.</p><img src="https://cdn.x/pixel.gif" width="1" height="1">', {
    ocr: state.ocr,
  })

  assert.equal(state.calls, 0)
})

test('a read too weak to trust yields no code rather than a wrong one', async () => {
  const store = await scan(IMAGE_ONLY, { ocr: reader('').ocr })

  assert.deepEqual(await store.listOffers(), [])
  assert.equal(store.processed.get('m1')?.status, 'no-code')
})

test('an OCR failure leaves the message processed on the text stages alone', async () => {
  const failing: OcrReader = async () => {
    throw new Error('offscreen document died')
  }

  const store = await scan(IMAGE_ONLY, { ocr: failing })

  assert.equal(store.processed.get('m1')?.status, 'no-code', 'not a terminal failure')
  assert.deepEqual(await store.listOffers(), [])
})

test('without an OCR reader the cascade still completes', async () => {
  const store = await scan(IMAGE_ONLY)

  assert.equal(store.processed.has('m1'), true)
  assert.deepEqual(await store.listOffers(), [])
})

test('a remote CDN banner is read, because that is where the code lives', async () => {
  const state = reader('USE CODE RAKE25 FOR 25% OFF')
  const store = await scan(IMAGE_ONLY, { ocr: state.ocr })

  assert.equal(state.calls, 1, 'an image-only coupon is unreachable any other way')
  assert.deepEqual(
    store.processed.get('m1')?.candidates.map((candidate) => candidate.source),
    ['ocr'],
  )
})

test('an inline banner is read through Gmail', async () => {
  const state = reader('USE CODE RAKE25 FOR 25% OFF')
  const store = await scan('<p>Monsoon Sale is live.</p>', {
    ocr: state.ocr,
    parts: INLINE_BANNER,
  })

  assert.equal(state.calls, 1, 'Google serves it; the sender learns nothing')
  assert.deepEqual(
    store.processed.get('m1')?.candidates.map((candidate) => candidate.source),
    ['ocr'],
  )
})

test('an inline part carries its own type, so it is not decoded as a PNG', async () => {
  let seen: string | null = null
  const ocr: OcrReader = async (candidates) => {
    seen = candidates[0]?.mimeType ?? null
    return { imagesConsidered: 1, imagesRead: 0, imagesAccepted: 0, meanConfidence: 0, text: '' }
  }

  await scan('<p>Monsoon Sale is live.</p>', { ocr, parts: INLINE_BANNER })

  assert.equal(seen, 'image/jpeg')
})
