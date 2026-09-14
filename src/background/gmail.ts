import type { AuthorizedFetchDeps } from '../types/auth.js'
import type {
  GmailAttachmentResponse,
  GmailListResponse,
  GmailMessage,
  GmailMessageRef,
  GmailMetadataResponse,
  GmailPort,
} from '../types/gmail.js'
import type { MessageSummary } from '../types/messaging.js'
import { mapWithConcurrency } from '../utils/concurrency.js'
import { authorizedFetch } from './auth.js'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** §6: used only when callers have not loaded the user's configured window. */
const DEFAULT_BACKFILL_DAYS = 45

/** §6: start conservatively; raise only if measured sync time demands it. */
const FETCH_CONCURRENCY = 5

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`Gmail ${status} on ${path}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    this.name = 'GmailApiError'
  }
}

async function gmailJson<T>(path: string, deps: AuthorizedFetchDeps): Promise<T> {
  const response = await authorizedFetch(`${GMAIL_BASE}${path}`, deps)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new GmailApiError(response.status, path, body)
  }
  return (await response.json()) as T
}

/**
 * Lists Promotions messages by label ID rather than a search string — the label
 * is the real category, `category:promotions` is only a query heuristic.
 */
export async function listPromotionMessageRefs(
  deps: AuthorizedFetchDeps,
  maxResults: number,
  newerThanDays: number = DEFAULT_BACKFILL_DAYS,
): Promise<GmailMessageRef[]> {
  const query = new URLSearchParams({
    labelIds: 'CATEGORY_PROMOTIONS',
    q: `newer_than:${newerThanDays}d`,
    maxResults: String(maxResults),
  })
  const page = await gmailJson<GmailListResponse>(`/messages?${query}`, deps)
  return page.messages ?? []
}

/** The popup list needs headers only, not full MIME bodies. */
async function fetchSummary(
  ref: GmailMessageRef,
  deps: AuthorizedFetchDeps,
): Promise<MessageSummary> {
  const query = new URLSearchParams({ format: 'metadata' })
  for (const header of ['Subject', 'From']) {
    query.append('metadataHeaders', header)
  }

  const message = await gmailJson<GmailMetadataResponse>(`/messages/${ref.id}?${query}`, deps)
  const headers = message.payload?.headers ?? []
  const header = (name: string): string =>
    headers.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value ?? ''

  return {
    id: message.id,
    threadId: message.threadId,
    subject: header('Subject') || '(no subject)',
    from: header('From'),
    date: Number(message.internalDate ?? 0),
  }
}

export async function listPromotionSummaries(
  deps: AuthorizedFetchDeps,
  maxResults: number,
  newerThanDays: number = DEFAULT_BACKFILL_DAYS,
): Promise<MessageSummary[]> {
  const refs = await listPromotionMessageRefs(deps, maxResults, newerThanDays)
  const summaries = await mapWithConcurrency(refs, FETCH_CONCURRENCY, (ref) =>
    fetchSummary(ref, deps),
  )
  return summaries.sort((a, b) => b.date - a.date)
}

/**
 * The backfill uses format=full because extraction needs the MIME tree.
 */
export function createGmailPort(deps: AuthorizedFetchDeps): GmailPort {
  return {
    async listPage({ newerThanDays, pageToken, pageSize }) {
      const query = new URLSearchParams({
        labelIds: 'CATEGORY_PROMOTIONS',
        q: `newer_than:${newerThanDays}d`,
        maxResults: String(pageSize),
      })
      if (pageToken) query.set('pageToken', pageToken)

      const page = await gmailJson<GmailListResponse>(
        `/messages?${query}`,
        deps,
      )
      return {
        ids: (page.messages ?? []).map((message) => message.id),
        nextPageToken: page.nextPageToken ?? null,
      }
    },

    getFull(messageId) {
      const id = encodeURIComponent(messageId)
      return gmailJson<GmailMessage>(`/messages/${id}?format=full`, deps)
    },

    async getAttachmentData(messageId, attachmentId) {
      const id = encodeURIComponent(messageId)
      const partId = encodeURIComponent(attachmentId)
      const attachment = await gmailJson<GmailAttachmentResponse>(
        `/messages/${id}/attachments/${partId}`,
        deps,
      )
      if (typeof attachment.data !== 'string') {
        throw new Error('Gmail attachment response did not include data')
      }
      return attachment.data
    },
  }
}
