import type { AuthorizedFetchDeps } from '../types/auth.js'
import type { MessageSummary } from '../types/messaging.js'
import { mapWithConcurrency } from '../utils/concurrency.js'
import { authorizedFetch } from './auth.js'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** §6: 45 days keeps the first run to 300-400 messages. Configurable in phase 4. */
export const BACKFILL_DAYS = 45

/** §6: start conservatively; raise only if measured sync time demands it. */
const FETCH_CONCURRENCY = 5

interface MessageRef {
  id: string
  threadId: string
}

interface ListResponse {
  messages?: MessageRef[]
  nextPageToken?: string
}

interface MetadataResponse {
  id: string
  threadId: string
  internalDate?: string
  payload?: { headers?: { name: string; value: string }[] }
}

async function gmailJson<T>(path: string, deps: AuthorizedFetchDeps): Promise<T> {
  const response = await authorizedFetch(`${GMAIL_BASE}${path}`, deps)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Gmail ${response.status} on ${path}${body ? `: ${body.slice(0, 200)}` : ''}`)
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
): Promise<MessageRef[]> {
  const query = new URLSearchParams({
    labelIds: 'CATEGORY_PROMOTIONS',
    q: `newer_than:${BACKFILL_DAYS}d`,
    maxResults: String(maxResults),
  })
  const page = await gmailJson<ListResponse>(`/messages?${query}`, deps)
  return page.messages ?? []
}

/** Metadata reduces payload size; every messages.get currently costs 20 quota units. */
async function fetchSummary(
  ref: MessageRef,
  deps: AuthorizedFetchDeps,
): Promise<MessageSummary> {
  const query = new URLSearchParams({ format: 'metadata' })
  for (const header of ['Subject', 'From']) {
    query.append('metadataHeaders', header)
  }

  const message = await gmailJson<MetadataResponse>(`/messages/${ref.id}?${query}`, deps)
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
): Promise<MessageSummary[]> {
  const refs = await listPromotionMessageRefs(deps, maxResults)
  const summaries = await mapWithConcurrency(refs, FETCH_CONCURRENCY, (ref) =>
    fetchSummary(ref, deps),
  )
  return summaries.sort((a, b) => b.date - a.date)
}
