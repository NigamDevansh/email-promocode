import type { BackfillDeps, BackfillResult } from '../types/backfill.js'
import type { GmailPage } from '../types/gmail.js'
import { LlmError } from '../types/llm.js'
import type { BackfillCheckpoint, OfferRecord, ProcessedRecord } from '../types/storage.js'
import { EXTRACTOR_VERSION, initialCheckpoint, META_KEYS } from '../utils/storage.js'
import { NotConnectedError, ReauthRequiredError } from './auth.js'
import { GmailApiError } from './gmail.js'
import {
  extractOne,
  isRetryable,
  MAX_RETRIES,
  MessageLlmError,
  RETRY_BASE_MS,
} from './process-message.js'

const PAGE_SIZE = 50
const MAX_PAGE_FETCHES = 10

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

    // §6: a finished full sync leaves a cursor for the incremental loop. The
    // value was captured before listing began, so anything that arrived during
    // the scan is still ahead of it.
    if (checkpoint.startHistoryId) {
      await store.setMeta(META_KEYS.historyId, checkpoint.startHistoryId)
    }
    complete = true
  }

  // Captured once per scan, before the first page is listed.
  if (checkpoint.status !== 'complete' && !checkpoint.startHistoryId) {
    const startHistoryId = await gmail.getProfileHistoryId().catch(() => null)
    if (startHistoryId) await save({ ...checkpoint, startHistoryId })
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
