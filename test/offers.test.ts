import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candidate } from '../src/types/extraction.ts'
import type { ParsedMessage } from '../src/types/gmail.ts'
import type { OfferRecord } from '../src/types/storage.ts'
import {
  describeConditions,
  describeExpiry,
  expiryStateOf,
  formatMoney,
} from '../src/utils/expiry.ts'
import {
  buildOffers,
  mergeOffer,
  searchOffers,
  sortOffersForDisplay,
} from '../src/utils/offers.ts'
import { EXTRACTOR_VERSION } from '../src/utils/storage.ts'

const TODAY = new Date(2026, 8, 14, 12)

function message(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: 'm1',
    threadId: 't1',
    internalDate: 1_757_600_000_000,
    subject: 'Weekend offer',
    from: 'Myntra <offers@mail.myntra.com>',
    senderDomain: 'mail.myntra.com',
    text: '',
    html: '',
    externalParts: [],
    ...overrides,
  }
}

const candidate = (source: Candidate['source'], code: string, score = 5): Candidate => ({
  code,
  normalized: code.toUpperCase(),
  source,
  score,
})

function offer(overrides: Partial<OfferRecord> = {}): OfferRecord {
  return {
    extractorVersion: EXTRACTOR_VERSION,
    code: 'SAVE20',
    normalizedCode: 'SAVE20',
    brand: 'Myntra',
    senderDomain: 'mail.myntra.com',
    brandKey: 'myntra',
    discount: null,
    currency: null,
    minSpend: null,
    maxDiscount: null,
    expiry: null,
    singleUse: null,
    newUsersOnly: false,
    appOnly: false,
    categories: [],
    conditions: '',
    source: 'text',
    needsReview: true,
    sourceMessageIds: ['m1'],
    sourceThreadId: 't1',
    sourceSender: 'Myntra <offers@mail.myntra.com>',
    sourceSubject: 'Weekend offer',
    sourceMessageDate: 1_000,
    ...overrides,
  }
}

test('promotes link and alt candidates but holds subject/body guesses back', () => {
  const built = buildOffers(message(), [
    candidate('link', 'LINK10'),
    candidate('alt', 'ALT20'),
    candidate('subject', 'SUBJ30'),
    candidate('text', 'BODY40'),
  ])

  assert.deepEqual(
    built.map((o) => o.normalizedCode),
    ['LINK10', 'ALT20'],
    'subject and body regex matches are gates for the later LLM phase',
  )
})

test('only a link-derived code is shown without a verify flag', () => {
  const built = buildOffers(message(), [candidate('link', 'LINK10'), candidate('alt', 'ALT20')])

  assert.equal(built[0]?.needsReview, false)
  assert.equal(built[0]?.source, 'link')
  assert.equal(built[1]?.needsReview, true)
  assert.equal(built[1]?.source, 'text')
})

test('built offers carry deterministic identity and full provenance', () => {
  const [built] = buildOffers(message(), [candidate('link', 'LINK10')])

  assert.equal(built?.brandKey, 'myntra', 'derived from the domain, never the display name')
  assert.equal(built?.brand, 'Myntra')
  assert.deepEqual(built?.sourceMessageIds, ['m1'])
  assert.equal(built?.sourceThreadId, 't1')
  assert.equal(built?.expiry, null, 'expiry is phase 4 work')
})

test('merging keeps every supporting message and the newest provenance', () => {
  const older = offer({ sourceMessageIds: ['m1'], sourceMessageDate: 1_000, sourceSubject: 'Old' })
  const newer = offer({ sourceMessageIds: ['m2'], sourceMessageDate: 2_000, sourceSubject: 'New' })

  const merged = mergeOffer(older, newer)

  assert.deepEqual(merged.sourceMessageIds, ['m1', 'm2'])
  assert.equal(merged.sourceSubject, 'New')
  assert.equal(merged.sourceMessageDate, 2_000)
})

test('a later bare mention cannot erase details an earlier email supplied', () => {
  const detailed = offer({
    sourceMessageDate: 1_000,
    discount: '20%',
    currency: 'INR',
    minSpend: 2_000,
    expiry: '2026-09-30',
  })
  const bare = offer({ sourceMessageDate: 2_000 })

  const merged = mergeOffer(detailed, bare)

  assert.equal(merged.discount, '20%')
  assert.equal(merged.currency, 'INR')
  assert.equal(merged.minSpend, 2_000)
  assert.equal(merged.expiry, '2026-09-30')
})

test('a link sighting upgrades a text-derived guess', () => {
  const guess = offer({ source: 'text', needsReview: true, sourceMessageDate: 2_000 })
  const exact = offer({ source: 'link', needsReview: false, sourceMessageDate: 1_000 })

  const merged = mergeOffer(guess, exact)

  assert.equal(merged.source, 'link')
  assert.equal(merged.needsReview, false)
})

test('merging into nothing returns the incoming offer unchanged', () => {
  const incoming = offer()
  assert.deepEqual(mergeOffer(undefined, incoming), incoming)
})

test('a new extractor does not inherit stale evidence from an old version', () => {
  const oldLink = offer({
    extractorVersion: EXTRACTOR_VERSION - 1,
    source: 'link',
    needsReview: false,
    sourceMessageIds: ['old-message'],
    sourceSubject: 'Old subject',
    sourceMessageDate: 2_000,
  })
  const currentAlt = offer({
    source: 'text',
    needsReview: true,
    sourceMessageIds: ['current-message'],
    sourceSubject: 'Current subject',
    sourceMessageDate: 1_000,
  })

  assert.deepEqual(mergeOffer(oldLink, currentAlt), currentAlt)
})

test('expiry is evaluated at read time, with expired offers kept and sorted last', () => {
  const sorted = sortOffersForDisplay(
    [
      offer({ normalizedCode: 'GONE', expiry: '2026-09-01' }),
      offer({ normalizedCode: 'LATER', expiry: '2026-09-30' }),
      offer({ normalizedCode: 'SOON', expiry: '2026-09-15' }),
      offer({ normalizedCode: 'UNKNOWN', expiry: null }),
    ],
    TODAY,
  )

  assert.deepEqual(
    sorted.map((o) => o.normalizedCode),
    ['SOON', 'LATER', 'UNKNOWN', 'GONE'],
  )
})

test('expiry states read against today, not against extraction time', () => {
  assert.deepEqual(expiryStateOf('2026-09-15', TODAY), { kind: 'active', daysLeft: 1 })
  assert.deepEqual(expiryStateOf('2026-09-14', TODAY), { kind: 'active', daysLeft: 0 })
  assert.deepEqual(expiryStateOf('2026-09-12', TODAY), { kind: 'expired', daysAgo: 2 })
  assert.deepEqual(expiryStateOf(null, TODAY), { kind: 'unknown' })
  assert.deepEqual(expiryStateOf('not-a-date', TODAY), { kind: 'unknown' })
  assert.deepEqual(expiryStateOf('2026-02-31', TODAY), { kind: 'unknown' })
})

test('expiry descriptions name the deadline rather than hiding it', () => {
  assert.equal(describeExpiry(expiryStateOf('2026-09-12', TODAY)), 'Expired 2 days ago')
  assert.equal(describeExpiry(expiryStateOf('2026-09-13', TODAY)), 'Expired yesterday')
  assert.equal(describeExpiry(expiryStateOf('2026-09-14', TODAY)), 'Expires today')
  assert.equal(describeExpiry(expiryStateOf('2026-09-15', TODAY)), 'Expires tomorrow')
  assert.equal(describeExpiry(expiryStateOf(null, TODAY)), 'No expiry given')
})

test('money is formatted with the offer currency, not a hardcoded symbol', () => {
  assert.equal(formatMoney(2000, 'INR'), '₹2,000')
  assert.equal(formatMoney(50, 'USD'), '$50')
  assert.equal(formatMoney(50, 'XYZ'), 'XYZ 50')
  assert.equal(formatMoney(null, 'INR'), null)
})

test('blocking conditions are surfaced alongside a code', () => {
  assert.equal(
    describeConditions(offer({ minSpend: 2000, currency: 'INR', newUsersOnly: true, appOnly: true })),
    'Min ₹2,000 · New users only · App only',
  )
  assert.equal(describeConditions(offer()), null)
})

test('search matches brand, code and source subject', () => {
  const offers = [
    offer({
      normalizedCode: 'SAVE20',
      brand: 'Myntra',
      brandKey: 'myntra',
      sourceSubject: 'Weekend offer',
    }),
    offer({
      normalizedCode: 'FLY50',
      brand: 'Air India',
      brandKey: 'airindia',
      sourceSubject: 'Flights to USA',
    }),
  ]

  assert.deepEqual(searchOffers(offers, 'myntra').map((o) => o.normalizedCode), ['SAVE20'])
  assert.deepEqual(searchOffers(offers, 'fly').map((o) => o.normalizedCode), ['FLY50'])
  assert.deepEqual(searchOffers(offers, 'usa').map((o) => o.normalizedCode), ['FLY50'])
  assert.equal(searchOffers(offers, '  ').length, 2)
})
