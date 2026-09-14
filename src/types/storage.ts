import type { Candidate } from './extraction.js'
import type { TokenUsage } from './llm.js'

export type ProcessedStatus = 'no-code' | 'candidates' | 'ignored' | 'failed'

/**
 * §9 `processed`: a completion record for positive, negative and terminal
 * failure results, so repeated scans do no repeated work.
 */
export interface ProcessedRecord {
  messageId: string
  threadId: string
  extractorVersion: number
  /** True once this message no longer needs a future LLM pass. */
  llmProcessed: boolean
  llmUsage?: TokenUsage
  status: ProcessedStatus
  processedAt: number
  candidates: Candidate[]
  /** Present only when status is 'failed'. */
  error?: string
}

/**
 * §9 offer record. Free extraction fills identity and provenance; the
 * LLM-derived commercial fields arrive in phase 4, so they are nullable now.
 */
export interface OfferRecord {
  /** Extractor that produced this derived row; used for safe cache migrations. */
  extractorVersion: number
  /** False for a free-only result that should be revisited after key setup. */
  llmProcessed: boolean
  code: string
  normalizedCode: string
  brand: string
  senderDomain: string
  brandKey: string
  discount: string | null
  currency: string | null
  minSpend: number | null
  maxDiscount: number | null
  expiry: string | null
  singleUse: boolean | null
  newUsersOnly: boolean
  appOnly: boolean
  categories: string[]
  conditions: string
  source: 'link' | 'text' | 'ocr'
  needsReview: boolean
  sourceMessageIds: string[]
  sourceThreadId: string
  sourceSender: string
  sourceSubject: string
  sourceMessageDate: number
}

/** §6 resumable backfill checkpoint, persisted in `meta`. */
export interface BackfillCheckpoint {
  status: 'idle' | 'running' | 'complete'
  query: string
  /** IDs of the page being worked, drained as each becomes terminal. */
  currentPageMessageIds: string[]
  nextPageToken: string | null
  processedCount: number
  extractorVersion: number
  /** True only after a configured LLM completed this whole scan window. */
  llmProcessed?: boolean
  nextAttemptAt: number | null
  /** Attempts per message ID, so one broken message cannot block the scan. */
  attempts: Record<string, number>
}

/**
 * Storage boundary. IndexedDB backs it in the service worker; tests use an
 * in-memory implementation, per §7's "mock only the narrow boundaries".
 */
export interface Store {
  getProcessed(messageId: string): Promise<ProcessedRecord | undefined>
  /** One transaction: offers and the processed record land together or not at all. */
  commitMessage(record: ProcessedRecord, offers: OfferRecord[]): Promise<void>
  listOffers(): Promise<OfferRecord[]>
  deleteStaleOffers(extractorVersion: number, requireLlm: boolean): Promise<void>
  getMeta<T>(key: string): Promise<T | undefined>
  setMeta<T>(key: string, value: T): Promise<void>
}
