import type { Candidate, CandidateSource } from '../types/extraction.js'
import type { ParsedMessage } from '../types/gmail.js'
import type { OfferRecord } from '../types/storage.js'
import { brandKeyFor, displayBrand } from './brand.js'
import { expiryStateOf } from './expiry.js'
import { EXTRACTOR_VERSION } from './storage.js'

// Subject/body guesses remain future LLM input; only direct link/alt evidence is shown now.
const PROMOTABLE: ReadonlySet<CandidateSource> = new Set(['link', 'alt'])

/** String form of the IndexedDB compound key, used by the test store. */
export function offerKey(offer: Pick<OfferRecord, 'brandKey' | 'normalizedCode'>): string {
  return JSON.stringify([offer.brandKey, offer.normalizedCode])
}

export function buildOffers(message: ParsedMessage, candidates: Candidate[]): OfferRecord[] {
  const brandKey = brandKeyFor(message.senderDomain, message.from)
  const brand = displayBrand(message.from, brandKey)
  const seen = new Set<string>()
  const offers: OfferRecord[] = []

  for (const candidate of candidates) {
    if (!PROMOTABLE.has(candidate.source) || seen.has(candidate.normalized)) continue
    seen.add(candidate.normalized)

    offers.push({
      extractorVersion: EXTRACTOR_VERSION,
      code: candidate.code,
      normalizedCode: candidate.normalized,
      brand,
      senderDomain: message.senderDomain,
      brandKey,
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
      source: candidate.source === 'link' ? 'link' : 'text',
      needsReview: candidate.source !== 'link',
      sourceMessageIds: [message.id],
      sourceThreadId: message.threadId,
      sourceSender: message.from,
      sourceSubject: message.subject,
      sourceMessageDate: message.internalDate,
    })
  }

  return offers
}

/** Combines duplicate brand/code records while keeping their source history. */
export function mergeOffer(existing: OfferRecord | undefined, incoming: OfferRecord): OfferRecord {
  if (!existing || existing.extractorVersion !== incoming.extractorVersion) return incoming

  const incomingIsNewer = incoming.sourceMessageDate >= existing.sourceMessageDate
  const newest = incomingIsNewer ? incoming : existing
  const oldest = incomingIsNewer ? existing : incoming

  return {
    ...newest,
    sourceMessageIds: [...new Set([...existing.sourceMessageIds, ...incoming.sourceMessageIds])],
    discount: newest.discount ?? oldest.discount,
    currency: newest.currency ?? oldest.currency,
    minSpend: newest.minSpend ?? oldest.minSpend,
    maxDiscount: newest.maxDiscount ?? oldest.maxDiscount,
    expiry: newest.expiry ?? oldest.expiry,
    singleUse: newest.singleUse ?? oldest.singleUse,
    newUsersOnly: newest.newUsersOnly || oldest.newUsersOnly,
    appOnly: newest.appOnly || oldest.appOnly,
    categories: [...new Set([...existing.categories, ...incoming.categories])],
    conditions: newest.conditions || oldest.conditions,
    source: existing.source === 'link' || incoming.source === 'link' ? 'link' : newest.source,
    needsReview: existing.needsReview && incoming.needsReview,
  }
}

/** Active deadlines first, unknown deadlines next, expired offers last. */
export function sortOffersForDisplay(offers: readonly OfferRecord[], today: Date): OfferRecord[] {
  return [...offers].sort((a, b) => {
    const left = expiryStateOf(a.expiry, today)
    const right = expiryStateOf(b.expiry, today)

    if ((left.kind === 'expired') !== (right.kind === 'expired')) {
      return left.kind === 'expired' ? 1 : -1
    }
    if (left.kind === 'active' && right.kind === 'active' && left.daysLeft !== right.daysLeft) {
      return left.daysLeft - right.daysLeft
    }
    if ((left.kind === 'active') !== (right.kind === 'active')) {
      return left.kind === 'active' ? -1 : 1
    }
    return b.sourceMessageDate - a.sourceMessageDate
  })
}

export function searchOffers(offers: readonly OfferRecord[], query: string): OfferRecord[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...offers]

  return offers.filter((offer) =>
    [offer.brand, offer.brandKey, offer.normalizedCode, offer.sourceSubject].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  )
}

export function gmailThreadUrl(offer: Pick<OfferRecord, 'sourceThreadId'>): string {
  return `https://mail.google.com/mail/u/0/#all/${offer.sourceThreadId}`
}
