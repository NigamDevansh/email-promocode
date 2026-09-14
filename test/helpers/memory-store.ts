import type { OfferRecord, ProcessedRecord, Store } from '../../src/types/storage.ts'
import { mergeOffer, offerKey } from '../../src/utils/offers.ts'

export interface MemoryStore extends Store {
  processed: Map<string, ProcessedRecord>
  offers: Map<string, OfferRecord>
  meta: Map<string, unknown>
  /** Number of commitMessage transactions, to assert atomic write counts. */
  commits: number
}

/** In-memory Store: the narrow IndexedDB boundary section 7 says to mock. */
export function createMemoryStore(): MemoryStore {
  const processed = new Map<string, ProcessedRecord>()
  const offers = new Map<string, OfferRecord>()
  const meta = new Map<string, unknown>()

  const store: MemoryStore = {
    processed,
    offers,
    meta,
    commits: 0,

    async getProcessed(messageId) {
      return processed.get(messageId)
    },

    async commitMessage(record, committedOffers) {
      // Mirrors the IndexedDB transaction: both halves land together.
      for (const offer of committedOffers) {
        const key = offerKey(offer)
        offers.set(key, mergeOffer(offers.get(key), offer))
      }
      processed.set(record.messageId, record)
      store.commits += 1
    },

    async listOffers() {
      return [...offers.values()]
    },

    async deleteOffersExceptVersion(extractorVersion) {
      for (const [key, offer] of offers) {
        if (offer.extractorVersion !== extractorVersion) offers.delete(key)
      }
    },

    async getMeta(key) {
      return meta.get(key) as never
    },

    async setMeta(key, value) {
      // Structured-clone semantics: callers must not mutate what they stored.
      meta.set(key, structuredClone(value))
    },
  }

  return store
}
