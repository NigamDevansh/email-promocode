import type { Candidate, CandidateSource } from '../types/extraction.js'
import type { ParsedMessage } from '../types/gmail.js'
import type { ExtractedOffer } from '../types/llm.js'
import type { OfferRecord } from '../types/storage.js'
import { brandKeyFor, displayBrand } from './brand.js'
import { EXTRACTOR_VERSION } from './storage.js'

// Without an LLM, only direct link/alt evidence is strong enough to show.
const PROMOTABLE: ReadonlySet<CandidateSource> = new Set(['link', 'alt'])

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
      llmProcessed: false,
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

export function mergeOffer(existing: OfferRecord | undefined, incoming: OfferRecord): OfferRecord {
  if (
    !existing ||
    existing.extractorVersion !== incoming.extractorVersion ||
    existing.llmProcessed !== incoming.llmProcessed
  ) {
    return incoming
  }

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

/** Deep link that opens the newest supporting message in Gmail. */
export function gmailThreadUrl(offer: Pick<OfferRecord, 'sourceThreadId'>): string {
  return `https://mail.google.com/mail/u/0/#all/${offer.sourceThreadId}`
}

/**
 * Phase 4: the LLM has confirmed each code against the candidate list, so a
 * body-text code is now as trustworthy as a link parameter and the commercial
 * fields are filled in. `needsReview` stays true only for OCR-derived codes,
 * which never reach this path before phase 7.
 */
export function buildOffersFromExtraction(
  message: ParsedMessage,
  extracted: readonly ExtractedOffer[],
  candidates: readonly Candidate[],
): OfferRecord[] {
  const brandKey = brandKeyFor(message.senderDomain, message.from)
  const brand = displayBrand(message.from, brandKey)
  const sourceOf = new Map(candidates.map((candidate) => [candidate.normalized, candidate.source]))

  return extracted.map((offer) => ({
    code: offer.code,
    normalizedCode: offer.normalizedCode,
    brand,
    senderDomain: message.senderDomain,
    brandKey,
    discount: offer.discount,
    currency: offer.currency,
    minSpend: offer.minSpend,
    maxDiscount: offer.maxDiscount,
    expiry: offer.expiry,
    singleUse: offer.singleUse,
    newUsersOnly: offer.newUsersOnly,
    appOnly: offer.appOnly,
    categories: offer.categories,
    conditions: offer.conditions,
    source: sourceOf.get(offer.normalizedCode) === 'link' ? 'link' : 'text',
    needsReview: false,
    extractorVersion: EXTRACTOR_VERSION,
    llmProcessed: true,
    sourceMessageIds: [message.id],
    sourceThreadId: message.threadId,
    sourceSender: message.from,
    sourceSubject: message.subject,
    sourceMessageDate: message.internalDate,
  }))
}
