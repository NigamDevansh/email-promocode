import type { BackfillDeps } from '../types/backfill.js'
import type { GmailPort } from '../types/gmail.js'
import type { IncrementalJob, IncrementalResult } from '../types/incremental.js'
import { LlmError } from '../types/llm.js'
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

/** Raised when Gmail no longer holds the requested cursor. §6 calls that routine. */
class CursorExpiredError extends Error { }

const emptyResult = (): IncrementalResult => ({
  discovered: 0,
  processed: 0,
  remaining: false,
  fullSyncRequired: false,
})

interface Discovery {
  messageIds: string[]
  pageToken: string | null
  historyId: string | null
  pagesWalked: number
}

/**
 * Walks history pages from `pageToken` until Gmail runs out or `maxPages` does.
 *
 * The page budget is per slice rather than per job: a mailbox with more than
 * `MAX_HISTORY_PAGES` of changes hands the leftover token back so the next
 * wake continues from exactly there.
 */
async function discover(
  gmail: GmailPort,
  startHistoryId: string,
  pageToken: string | null,
  maxPages: number,
): Promise<Discovery> {
  const found = new Set<string>()
  let token = pageToken
  let historyId: string | null = null
  let pagesWalked = 0

  while (pagesWalked < maxPages) {
    let page
    try {
      page = await gmail.listHistory({ startHistoryId, pageToken: token })
    } catch (error) {
      // §6 "Full sync is routine": a cursor older than Gmail's retention is
      // normal operation after a week away, not an exceptional recovery path.
      if (error instanceof GmailApiError && error.status === 404) throw new CursorExpiredError()
      throw error
    }

    for (const id of page.messageIds) found.add(id)
    if (page.historyId) historyId = page.historyId
    token = page.nextPageToken
    pagesWalked += 1
    if (!token) break
  }

  return { messageIds: [...found], pageToken: token, historyId, pagesWalked }
}

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
  let pagesLeft = MAX_HISTORY_PAGES

  const save = async (next: IncrementalJob): Promise<void> => {
    job = next
    await store.setMeta(META_KEYS.incremental, next)
  }

  const dropCursor = async (): Promise<IncrementalResult> => {
    await store.setMeta(META_KEYS.historyId, undefined)
    await store.setMeta(META_KEYS.incremental, undefined)
    return { ...emptyResult(), fullSyncRequired: true }
  }

  // §6 step 1: resume a persisted job before asking Gmail for more changes.
  if (persisted) {
    job = persisted
  } else {
    let found: Discovery
    try {
      found = await discover(gmail, committed, null, pagesLeft)
    } catch (error) {
      if (error instanceof CursorExpiredError) return await dropCursor()
      throw error
    }

    pagesLeft -= found.pagesWalked
    discovered += found.messageIds.length

    if (found.messageIds.length === 0 && !found.pageToken) {
      // Nothing new. Move the cursor forward so the next call starts from here.
      await store.setMeta(META_KEYS.historyId, found.historyId ?? committed)
      return emptyResult()
    }

    // §6 step 4: persist the job and its target cursor before parsing anything.
    job = {
      pendingMessageIds: found.messageIds,
      targetHistoryId: found.historyId ?? committed,
      pageToken: found.pageToken,
      attempts: {},
      nextAttemptAt: null,
    }
    await store.setMeta(META_KEYS.incremental, job)
  }

  let processed = 0
  let stopped = false

  // Two nested loops, because draining the pending list can uncover more
  // history to walk: a job that still holds a `pageToken` is only finished once
  // that token has been followed. Leaving it unfollowed would strand the job —
  // pending empty, cursor frozen, and no further history query ever made.
  for (; ;) {
    while (job.pendingMessageIds.length > 0 && processed < budget) {
      if (deps.shouldContinue && !deps.shouldContinue()) {
        stopped = true
        break
      }

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
        if (failure instanceof LlmError && (failure.kind === 'auth' || failure.kind === 'model')) {
          throw failure
        }

        if (retryable) {
          const attempts = (job.attempts[messageId] ?? 0) + 1
          if (attempts <= MAX_RETRIES) {
            const jitter = 0.75 + (deps.random ?? Math.random)() * 0.5
            const exponentialDelay = RETRY_BASE_MS * 2 ** (attempts - 1) * jitter
            const providerDelay = failure instanceof LlmError ? failure.retryAfterMs ?? 0 : 0
            const nextAttemptAt = now() + Math.max(exponentialDelay, providerDelay)
            await save({
              ...job,
              attempts: { ...job.attempts, [messageId]: attempts },
              nextAttemptAt,
            })
            return {
              discovered,
              processed,
              remaining: true,
              fullSyncRequired: false,
              nextAttemptAt,
              error: message,
            }
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

    const canContinue =
      !stopped &&
      job.pendingMessageIds.length === 0 &&
      job.pageToken !== null &&
      pagesLeft > 0 &&
      processed < budget
    if (!canContinue) break

    let found: Discovery
    try {
      found = await discover(gmail, committed, job.pageToken, pagesLeft)
    } catch (error) {
      if (error instanceof CursorExpiredError) return await dropCursor()
      throw error
    }

    pagesLeft -= found.pagesWalked
    discovered += found.messageIds.length

    // Same commit order as the first page: IDs and target land before parsing.
    await save({
      ...job,
      pendingMessageIds: found.messageIds,
      pageToken: found.pageToken,
      targetHistoryId: found.historyId ?? job.targetHistoryId,
    })
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
