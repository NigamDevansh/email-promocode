import type { ChatTurnRecord } from '../../src/types/chat.ts'
import type { OfferRecord, ProcessedRecord, Store } from '../../src/types/storage.ts'
import { mergeOffer, offerKey } from '../../src/utils/offers.ts'

export interface MemoryStore extends Store {
  processed: Map<string, ProcessedRecord>
  offers: Map<string, OfferRecord>
  meta: Map<string, unknown>
  chat: Map<string, ChatTurnRecord>
  /** Number of commitMessage transactions, to assert atomic write counts. */
  commits: number
}

/** In-memory Store: the narrow IndexedDB boundary section 7 says to mock. */
export function createMemoryStore(): MemoryStore {
  const processed = new Map<string, ProcessedRecord>()
  const offers = new Map<string, OfferRecord>()
  const meta = new Map<string, unknown>()
  const chat = new Map<string, ChatTurnRecord>()

  const store: MemoryStore = {
    processed,
    offers,
    meta,
    chat,
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

    async deleteStaleOffers(extractorVersion, requireLlm) {
      for (const [key, offer] of offers) {
        if (
          offer.extractorVersion !== extractorVersion ||
          (requireLlm && !offer.llmProcessed)
        ) {
          offers.delete(key)
        }
      }
    },

    async deleteExpiredOffers(before) {
      for (const [key, offer] of offers) {
        if (offer.expiry !== null && offer.expiry < before) offers.delete(key)
      }
    },

    async listChatTurns() {
      return [...chat.values()].sort((left, right) => left.createdAt - right.createdAt)
    },

    async replaceChatTurns(turns) {
      chat.clear()
      for (const turn of turns) chat.set(turn.turnId, structuredClone(turn))
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
