import type { BackfillDeps, BackfillResult, MessageExtraction } from '../types/backfill.js'
import type { GmailPage } from '../types/gmail.js'
import {
  type BackfillCheckpoint,
  type OfferRecord,
  type ProcessedRecord,
} from '../types/storage.js'
import { gateMessage } from '../utils/candidates.js'
import { hydrateExternalParts, parseGmailMessage } from '../utils/mime.js'
import { extractMessageOffers } from '../llm/extract-message.js'
import { LlmError } from '../types/llm.js'
import { buildOffers, buildOffersFromExtraction } from '../utils/offers.js'
import { EXTRACTOR_VERSION, initialCheckpoint, META_KEYS } from '../utils/storage.js'
import { NotConnectedError, ReauthRequiredError } from './auth.js'
import { GmailApiError } from './gmail.js'

/** §6: retry a transient failure at most four times, then move on. */
const MAX_RETRIES = 4
const PAGE_SIZE = 50
const RETRY_BASE_MS = 30_000
const MAX_PAGE_FETCHES = 10

class MessageLlmError extends Error {
  constructor(
    readonly llmError: LlmError,
    readonly fallback: MessageExtraction,
  ) {
    super(llmError.message)
    this.name = 'MessageLlmError'
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (error instanceof LlmError) return error.retryable
  return (
    error instanceof GmailApiError &&
    (error.status === 408 || error.status === 429 || error.status >= 500)
  )
}

async function extractOne(messageId: string, deps: BackfillDeps): Promise<MessageExtraction> {
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
  const gate = gateMessage(hydrated)

  // §7: the LLM stage runs only when the free stages found something worth
  // spending a token on. A no-code message never reaches a provider.
  let offers = buildOffers(hydrated, gate.candidates)
  const shouldRunLlm = Boolean(deps.llm && gate.shouldExtract && gate.candidates.length > 0)
  let llmProcessed = !gate.shouldExtract || gate.candidates.length === 0
  let llmUsage: ProcessedRecord['llmUsage']

  if (shouldRunLlm && deps.llm) {
    try {
      const run = await extractMessageOffers(hydrated, gate.candidates, deps.llm)
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
    },
    offers,
  }
}

/** Processes one checkpointed, restart-safe slice of the first-run backfill. */
export async function runBackfillSlice(deps: BackfillDeps): Promise<BackfillResult> {
  const { store, gmail, now, random = Math.random, budget, backfillDays } = deps
  const query = `newer_than:${backfillDays}d`

  let checkpoint =
    (await store.getMeta<BackfillCheckpoint>(META_KEYS.backfill)) ?? initialCheckpoint(query)

  // A version bump restarts extraction but leaves the last usable offer cache in
  // place until the replacement scan completes successfully.
  if (checkpoint.extractorVersion !== EXTRACTOR_VERSION) {
    checkpoint = initialCheckpoint(query)
    await store.setMeta(META_KEYS.backfill, checkpoint)
  } else if (checkpoint.query !== query) {
    checkpoint = initialCheckpoint(query)
    await store.setMeta(META_KEYS.backfill, checkpoint)
  }

  if (checkpoint.status === 'complete') {
    if (deps.llm && checkpoint.llmProcessed !== true) {
      checkpoint = initialCheckpoint(query)
      await store.setMeta(META_KEYS.backfill, checkpoint)
    } else {
      return { processed: 0, skipped: 0, withCandidates: 0, remaining: false }
    }
  }

  if (checkpoint.nextAttemptAt && checkpoint.nextAttemptAt > now()) {
    return {
      processed: 0,
      skipped: 0,
      withCandidates: 0,
      remaining: true,
      nextAttemptAt: checkpoint.nextAttemptAt,
    }
  }

  let processed = 0
  let skipped = 0
  let withCandidates = 0
  let examined = 0
  let pageFetches = 0
  let complete = false

  const save = async (next: BackfillCheckpoint): Promise<void> => {
    checkpoint = next
    await store.setMeta(META_KEYS.backfill, checkpoint)
  }

  const finish = async (): Promise<void> => {
    await store.deleteStaleOffers(EXTRACTOR_VERSION, Boolean(deps.llm))
    await save({ ...checkpoint, status: 'complete', llmProcessed: Boolean(deps.llm) })
    complete = true
  }

  while (examined < budget) {
    if (deps.shouldContinue && !deps.shouldContinue()) break

    if (checkpoint.currentPageMessageIds.length === 0) {
      if (checkpoint.status === 'running' && checkpoint.nextPageToken === null) {
        await finish()
        break
      }

      // Leaves `complete` false, so the slice reports work remaining.
      if (pageFetches >= MAX_PAGE_FETCHES) break

      let page: GmailPage
      pageFetches += 1
      try {
        page = await gmail.listPage({
          newerThanDays: backfillDays,
          pageToken: checkpoint.nextPageToken,
          pageSize: PAGE_SIZE,
        })
      } catch (error) {
        if (checkpoint.nextPageToken && error instanceof GmailApiError && error.status === 400) {
          checkpoint = initialCheckpoint(query)
          await store.setMeta(META_KEYS.backfill, checkpoint)
          continue
        }
        throw error
      }

      await save({
        ...checkpoint,
        status: 'running',
        currentPageMessageIds: page.ids,
        nextPageToken: page.nextPageToken,
      })
      continue
    }

    const messageId = checkpoint.currentPageMessageIds[0] as string
    const rest = checkpoint.currentPageMessageIds.slice(1)

    const existing = await store.getProcessed(messageId)
    const needsLlmPass = Boolean(
      deps.llm && existing?.status === 'candidates' && existing.llmProcessed !== true,
    )
    if (existing && existing.extractorVersion === EXTRACTOR_VERSION && !needsLlmPass) {
      const pageComplete = rest.length === 0 && checkpoint.nextPageToken === null
      await save({
        ...checkpoint,
        currentPageMessageIds: rest,
        processedCount: checkpoint.processedCount + 1,
      })
      skipped += 1
      examined += 1
      if (pageComplete) {
        await finish()
        break
      }
      continue
    }

    let record: ProcessedRecord
    let offers: OfferRecord[] = []
    try {
      const extraction = await extractOne(messageId, deps)
      record = extraction.record
      offers = extraction.offers
    } catch (error) {
      const failure = error instanceof MessageLlmError ? error.llmError : error
      const message = failure instanceof Error ? failure.message : String(failure)
      if (failure instanceof NotConnectedError || failure instanceof ReauthRequiredError) {
        throw failure
      }

      const retryable = isRetryable(failure)
      if (failure instanceof GmailApiError && failure.status !== 404 && !retryable) {
        throw failure
      }
      // §6: never retry authentication or invalid-model errors. They are
      // settings problems, so stop the slice instead of marking this message
      // failed and poisoning the completion cache for every message after it.
      if (
        failure instanceof LlmError &&
        (failure.kind === 'auth' || failure.kind === 'model')
      ) {
        throw failure
      }

      const attempts = (checkpoint.attempts[messageId] ?? 0) + 1
      if (retryable && attempts <= MAX_RETRIES) {
        const jitter = 0.75 + random() * 0.5
        const exponentialDelay = RETRY_BASE_MS * 2 ** (attempts - 1) * jitter
        const providerDelay = failure instanceof LlmError ? failure.retryAfterMs ?? 0 : 0
        const nextAttemptAt = now() + Math.max(exponentialDelay, providerDelay)
        await save({
          ...checkpoint,
          attempts: { ...checkpoint.attempts, [messageId]: attempts },
          nextAttemptAt,
        })
        return {
          processed,
          skipped,
          withCandidates,
          remaining: true,
          nextAttemptAt,
          error: message,
        }
      }

      // Deleted messages and deterministic parser failures are terminal.
      if (error instanceof MessageLlmError) {
        record = error.fallback.record
        offers = error.fallback.offers
      } else {
        record = {
          messageId,
          threadId: '',
          extractorVersion: EXTRACTOR_VERSION,
          llmProcessed: true,
          status: 'failed',
          processedAt: now(),
          candidates: [],
          error: message,
        }
      }
    }

    // One transaction: offers and the processed record land together or not at all.
    await store.commitMessage(record, offers)

    const attempts = { ...checkpoint.attempts }
    delete attempts[messageId]

    const pageComplete = rest.length === 0 && checkpoint.nextPageToken === null
    await save({
      ...checkpoint,
      currentPageMessageIds: rest,
      processedCount: checkpoint.processedCount + 1,
      nextAttemptAt: null,
      attempts,
    })
    processed += 1
    examined += 1
    if (record.status === 'candidates') withCandidates += 1
    if (pageComplete) {
      await finish()
      break
    }
  }

  return { processed, skipped, withCandidates, remaining: !complete }
}
