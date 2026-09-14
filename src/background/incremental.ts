import type { BackfillDeps } from '../types/backfill.js'
import type { IncrementalJob, IncrementalResult } from '../types/incremental.js'
import type { OfferRecord, ProcessedRecord } from '../types/storage.js'
import { EXTRACTOR_VERSION, META_KEYS } from '../utils/storage.js'
import { NotConnectedError, ReauthRequiredError } from './auth.js'
import { GmailApiError } from './gmail.js'
import {
  extractOne,
  isRetryable,
  MAX_RETRIES,
  MessageLlmError,
  RETRY_BASE_MS,
} from './process-message.js'

/** History can span many pages after a long gap; one wake walks a bounded slice. */
const MAX_HISTORY_PAGES = 10

const emptyResult = (): IncrementalResult => ({
  discovered: 0,
  processed: 0,
  remaining: false,
  fullSyncRequired: false,
})

/**
 * §6's incremental loop.
 *
 * The commit order is the point of the whole design: the discovered message IDs
 * and their target `historyId` are persisted *before* any message is parsed,
 * and the cursor only advances once every ID is terminal. Advancing it earlier
 * would let a service-worker shutdown skip new mail permanently — the one
 * failure this system cannot detect afterwards.
 */
export async function runIncrementalSlice(deps: BackfillDeps): Promise<IncrementalResult> {
  const { store, gmail, now, budget } = deps

  const committed = await store.getMeta<string>(META_KEYS.historyId)
  // No cursor yet means the first full scan has not finished; nothing to do.
  if (!committed) return emptyResult()

  const persisted = await store.getMeta<IncrementalJob>(META_KEYS.incremental)
  let discovered = 0

  if (persisted?.nextAttemptAt && persisted.nextAttemptAt > now()) {
    return { ...emptyResult(), remaining: true, nextAttemptAt: persisted.nextAttemptAt }
  }

  let job: IncrementalJob

  const save = async (next: IncrementalJob): Promise<void> => {
    job = next
    await store.setMeta(META_KEYS.incremental, next)
  }

  // §6 step 1: resume a persisted job before asking Gmail for more changes.
  if (persisted) {
    job = persisted
  } else {
    const found = new Set<string>()
    let pageToken: string | null = null
    let targetHistoryId = committed
    let pages = 0

    do {
      let page
      try {
        page = await gmail.listHistory({ startHistoryId: committed, pageToken })
      } catch (error) {
        // §6 "Full sync is routine": a cursor older than Gmail's retention is
        // normal operation after a week away, not an exceptional recovery path.
        if (error instanceof GmailApiError && error.status === 404) {
          await store.setMeta(META_KEYS.historyId, undefined)
          await store.setMeta(META_KEYS.incremental, undefined)
          return { ...emptyResult(), fullSyncRequired: true }
        }
        throw error
      }

      for (const id of page.messageIds) found.add(id)
      if (page.historyId) targetHistoryId = page.historyId
      pageToken = page.nextPageToken
      pages += 1
    } while (pageToken && pages < MAX_HISTORY_PAGES)

    discovered = found.size

    if (found.size === 0 && !pageToken) {
      // Nothing new. Move the cursor forward so the next call starts from here.
      await store.setMeta(META_KEYS.historyId, targetHistoryId)
      return emptyResult()
    }

    // §6 step 4: persist the job and its target cursor before parsing anything.
    job = {
      pendingMessageIds: [...found],
      targetHistoryId,
      pageToken,
      attempts: {},
      nextAttemptAt: null,
    }
    await store.setMeta(META_KEYS.incremental, job)
  }

  let processed = 0

  while (job.pendingMessageIds.length > 0 && processed < budget) {
    if (deps.shouldContinue && !deps.shouldContinue()) break

    const messageId = job.pendingMessageIds[0] as string
    const rest = job.pendingMessageIds.slice(1)

    const existing = await store.getProcessed(messageId)
    const needsLlmPass = Boolean(
      deps.llm && existing?.status === 'candidates' && existing.llmProcessed !== true,
    )
    if (existing && existing.extractorVersion === EXTRACTOR_VERSION && !needsLlmPass) {
      await save({ ...job, pendingMessageIds: rest })
      continue
    }

    let record: ProcessedRecord
    let offers: OfferRecord[]
    try {
      const extraction = await extractOne(messageId, deps)
      record = extraction.record
      offers = extraction.offers
    } catch (error) {
      if (error instanceof NotConnectedError || error instanceof ReauthRequiredError) throw error

      const failure = error instanceof MessageLlmError ? error.llmError : error
      const message = failure instanceof Error ? failure.message : String(failure)
      const retryable = isRetryable(failure)

      if (failure instanceof GmailApiError && failure.status !== 404 && !retryable) throw failure

      if (retryable) {
        const attempts = (job.attempts[messageId] ?? 0) + 1
        if (attempts < MAX_RETRIES) {
          const jitter = 0.75 + (deps.random ?? Math.random)() * 0.5
          const nextAttemptAt = now() + RETRY_BASE_MS * 2 ** (attempts - 1) * jitter
          await save({
            ...job,
            attempts: { ...job.attempts, [messageId]: attempts },
            nextAttemptAt,
          })
          return { discovered, processed, remaining: true, fullSyncRequired: false, nextAttemptAt, error: message }
        }
      }

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
        offers = []
      }
    }

    await store.commitMessage(record, offers)

    const attempts = { ...job.attempts }
    delete attempts[messageId]
    await save({ ...job, pendingMessageIds: rest, attempts, nextAttemptAt: null })
    processed += 1
  }

  // §6 step 6: only now is it safe to move the cursor. Mail that arrived while
  // this job ran sits after the target and is picked up by the next sync.
  if (job.pendingMessageIds.length === 0 && !job.pageToken) {
    await store.setMeta(META_KEYS.historyId, job.targetHistoryId)
    await store.setMeta(META_KEYS.incremental, undefined)
    return { discovered, processed, remaining: false, fullSyncRequired: false }
  }

  return { discovered, processed, remaining: true, fullSyncRequired: false }
}
