import type { BackfillDeps, BackfillResult, MessageExtraction } from '../types/backfill.js'
import type { GmailPage } from '../types/gmail.js'
import {
  type BackfillCheckpoint,
  type OfferRecord,
  type ProcessedRecord,
} from '../types/storage.js'
import { gateMessage } from '../utils/candidates.js'
import { hydrateExternalParts, parseGmailMessage } from '../utils/mime.js'
import { buildOffers } from '../utils/offers.js'
import { EXTRACTOR_VERSION, initialCheckpoint, META_KEYS } from '../utils/storage.js'
import { NotConnectedError, ReauthRequiredError } from './auth.js'
import { GmailApiError } from './gmail.js'

/** §6: cap retries at four, then record a terminal failure and move on. */
const MAX_ATTEMPTS = 4
const PAGE_SIZE = 50
const RETRY_BASE_MS = 30_000
const MAX_PAGE_FETCHES = 10

function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) return true
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

  const gate = gateMessage({ ...parsed, text, html })

  return {
    record: {
      messageId: parsed.id,
      threadId: parsed.threadId,
      extractorVersion: EXTRACTOR_VERSION,
      status: gate.shouldExtract ? 'candidates' : 'no-code',
      processedAt: deps.now(),
      candidates: gate.candidates,
    },
    offers: buildOffers({ ...parsed, text, html }, gate.candidates),
  }
}

/** Processes one checkpointed, restart-safe slice of the first-run backfill. */
export async function runBackfillSlice(deps: BackfillDeps): Promise<BackfillResult> {
  const { store, gmail, now, budget, backfillDays } = deps
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
    return { processed: 0, skipped: 0, withCandidates: 0, remaining: false }
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
    await store.deleteOffersExceptVersion(EXTRACTOR_VERSION)
    await save({ ...checkpoint, status: 'complete' })
    complete = true
  }

  while (examined < budget) {
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
    if (existing && existing.extractorVersion === EXTRACTOR_VERSION) {
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
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof NotConnectedError || error instanceof ReauthRequiredError) throw error

      const retryable = isRetryable(error)
      if (error instanceof GmailApiError && error.status !== 404 && !retryable) {
        throw error
      }

      const attempts = (checkpoint.attempts[messageId] ?? 0) + 1
      if (retryable && attempts < MAX_ATTEMPTS) {
        const nextAttemptAt = now() + RETRY_BASE_MS * 2 ** (attempts - 1)
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
      record = {
        messageId,
        threadId: '',
        extractorVersion: EXTRACTOR_VERSION,
        status: 'failed',
        processedAt: now(),
        candidates: [],
        error: message,
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
