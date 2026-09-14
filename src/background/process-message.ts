import { extractMessageOffers } from '../llm/extract-message.js'
import type { BackfillDeps, MessageExtraction } from '../types/backfill.js'
import { LlmError } from '../types/llm.js'
import type { OcrRun } from '../types/ocr.js'
import type { ProcessedRecord } from '../types/storage.js'
import { gateMessage } from '../utils/candidates.js'
import { selectOcrImages } from '../utils/images.js'
import { hydrateExternalParts, parseGmailMessage } from '../utils/mime.js'
import { buildOffers, buildOffersFromExtraction } from '../utils/offers.js'
import { EXTRACTOR_VERSION } from '../utils/storage.js'
import { GmailApiError } from './gmail.js'

/*
 * The per-message pipeline, shared by the first-run backfill and the §6
 * incremental loop. Both walk different lists of message IDs, but what happens
 * to one message is identical either way.
 */

/** §6: retry a transient failure at most four times, then move on. */
export const MAX_RETRIES = 4
export const RETRY_BASE_MS = 30_000

export class MessageLlmError extends Error {
  constructor(
    readonly llmError: LlmError,
    readonly fallback: MessageExtraction,
  ) {
    super(llmError.message)
    this.name = 'MessageLlmError'
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (error instanceof LlmError) return error.retryable
  return (
    error instanceof GmailApiError &&
    (error.status === 408 || error.status === 429 || error.status >= 500)
  )
}

export async function extractOne(messageId: string, deps: BackfillDeps): Promise<MessageExtraction> {
  const message = await deps.gmail.getFull(messageId)

  if (!message.labelIds?.includes('CATEGORY_PROMOTIONS')) {
    return {
      record: {
        messageId: message.id,
        threadId: message.threadId,
        extractorVersion: EXTRACTOR_VERSION,
        llmProcessed: true,
        status: 'ignored',
        processedAt: deps.now(),
        candidates: [],
      },
      offers: [],
    }
  }

  const parsed = parseGmailMessage(message)
  let { text, html } = parsed
  if (parsed.externalParts.length > 0) {
    const hydrated = await hydrateExternalParts(
      { text, html, external: parsed.externalParts },
      (attachmentId) => deps.gmail.getAttachmentData(messageId, attachmentId),
    )
    text = hydrated.text
    html = hydrated.html
  }

  const hydrated = { ...parsed, text, html }
  let gate = gateMessage(hydrated)
  let ocr: OcrRun | undefined

  // §7: OCR is the last stage and only runs once the free text stages have
  // failed. Its output re-enters the same candidate detection, so an image-only
  // banner is treated exactly like body text from here on — except that §11
  // keeps every OCR-derived code flagged for review.
  if (deps.ocr && gate.candidates.length === 0) {
    const images = selectOcrImages(message.payload)
    if (images.length > 0) {
      ocr = await deps.ocr(images, messageId, deps.gmail).catch(() => undefined)
      if (ocr?.text) gate = gateMessage(hydrated, ocr.text)
    }
  }

  // §7: the LLM stage runs only when the free stages found something worth
  // spending a token on. A no-code message never reaches a provider.
  let offers = buildOffers(hydrated, gate.candidates)
  const shouldRunLlm = Boolean(deps.llm && gate.shouldExtract && gate.candidates.length > 0)
  let llmProcessed = !gate.shouldExtract || gate.candidates.length === 0
  let llmUsage: ProcessedRecord['llmUsage']

  if (shouldRunLlm && deps.llm) {
    try {
      const run = await extractMessageOffers(hydrated, gate.candidates, deps.llm, ocr?.text)
      offers = buildOffersFromExtraction(hydrated, run.offers, gate.candidates)
      llmProcessed = true
      llmUsage = run.usage
    } catch (error) {
      if (!(error instanceof LlmError)) throw error

      throw new MessageLlmError(error, {
        record: {
          messageId: parsed.id,
          threadId: parsed.threadId,
          extractorVersion: EXTRACTOR_VERSION,
          llmProcessed: true,
          status: 'failed',
          processedAt: deps.now(),
          candidates: gate.candidates,
          ...(ocr ? { ocr } : {}),
          error: error.message,
        },
        // Keep Phase 3's direct evidence if the model cannot enrich it.
        offers: offers.map((offer) => ({ ...offer, llmProcessed: true })),
      })
    }
  }

  return {
    record: {
      messageId: parsed.id,
      threadId: parsed.threadId,
      extractorVersion: EXTRACTOR_VERSION,
      llmProcessed,
      ...(llmUsage ? { llmUsage } : {}),
      status: gate.shouldExtract ? 'candidates' : 'no-code',
      processedAt: deps.now(),
      candidates: gate.candidates,
      ...(ocr ? { ocr } : {}),
    },
    offers,
  }
}
