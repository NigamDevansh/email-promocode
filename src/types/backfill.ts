import type { ExtractionDeps } from './llm.js'
import type { GmailPort } from './gmail.js'
import type { ImageCandidate, OcrRun } from './ocr.js'
import type { OfferRecord, ProcessedRecord, Store } from './storage.js'

export interface BackfillDeps {
  store: Store
  gmail: GmailPort
  now: () => number
  /** Injectable only so retry jitter remains deterministic in tests. */
  random?: () => number
  /** Stops a slice between messages after its runtime configuration changes. */
  shouldContinue?: () => boolean
  /** Maximum message IDs examined in one service-worker wake. */
  budget: number
  backfillDays: number
  /**
   * Absent until a provider and key are configured. Phases 1-3 run the free
   * extraction stages alone, which is why they need no LLM key at all.
   */
  llm?: ExtractionDeps
  /**
   * §7 phase 7. OCR is not a user-facing option; this is injectable only so the
   * cascade can be tested without an offscreen document. The service worker
   * always supplies it.
   */
  ocr?: OcrReader
}

export type OcrReader = (
  candidates: readonly ImageCandidate[],
  messageId: string,
  gmail: GmailPort,
) => Promise<OcrRun>

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
