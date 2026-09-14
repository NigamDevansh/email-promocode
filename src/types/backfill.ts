import type { GmailPort } from './gmail.js'
import type { OfferRecord, ProcessedRecord, Store } from './storage.js'

export interface BackfillDeps {
  store: Store
  gmail: GmailPort
  now: () => number
  /** Maximum message IDs examined in one service-worker wake. */
  budget: number
  backfillDays: number
}

export interface BackfillResult {
  processed: number
  skipped: number
  withCandidates: number
  remaining: boolean
  nextAttemptAt?: number
  error?: string
}

export interface MessageExtraction {
  record: ProcessedRecord
  offers: OfferRecord[]
}
