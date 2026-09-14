import type { AuthorizedFetchDeps } from '../types/auth.js'
import type {
  GmailAttachmentResponse,
  GmailListResponse,
  GmailMessage,
  GmailPort,
} from '../types/gmail.js'
import { authorizedFetch } from './auth.js'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
    readonly reason?: string,
  ) {
    super(`Gmail ${status} on ${path}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    this.name = 'GmailApiError'
  }
}

function gmailErrorReason(body: string): string | undefined {
  try {
    const payload = JSON.parse(body) as {
      error?: {
        errors?: Array<{ reason?: unknown }>
        details?: Array<{ reason?: unknown }>
      }
    }
    const legacyReason = payload.error?.errors?.find(
      (entry) => typeof entry.reason === 'string',
    )?.reason
    if (typeof legacyReason === 'string') return legacyReason

    const detailReason = payload.error?.details?.find(
      (entry) => typeof entry.reason === 'string',
    )?.reason
    return typeof detailReason === 'string' ? detailReason : undefined
  } catch {
    return undefined
  }
}

async function gmailJson<T>(path: string, deps: AuthorizedFetchDeps): Promise<T> {
  const response = await authorizedFetch(`${GMAIL_BASE}${path}`, deps)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new GmailApiError(response.status, path, body, gmailErrorReason(body))
  }
  return (await response.json()) as T
}

/**
 * Lists Promotions messages by label ID rather than a search string — the label
 * is the real category, `category:promotions` is only a query heuristic.
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

    async getProfileHistoryId() {
      const profile = await gmailJson<{ historyId?: string }>('/profile', deps)
      return profile.historyId ?? ''
    },

    async listHistory({ startHistoryId, pageToken }) {
      const query = new URLSearchParams({
        startHistoryId,
        // §6: new mail, plus mail relabelled into Promotions after arrival.
        labelId: 'CATEGORY_PROMOTIONS',
      })
      query.append('historyTypes', 'messageAdded')
      query.append('historyTypes', 'labelAdded')
      if (pageToken) query.set('pageToken', pageToken)

      const page = await gmailJson<{
        history?: {
          messagesAdded?: { message?: { id?: string } }[]
          labelsAdded?: { message?: { id?: string } }[]
        }[]
        nextPageToken?: string
        historyId?: string
      }>(`/history?${query}`, deps)

      const messageIds = new Set<string>()
      for (const record of page.history ?? []) {
        for (const added of [...(record.messagesAdded ?? []), ...(record.labelsAdded ?? [])]) {
          if (added.message?.id) messageIds.add(added.message.id)
        }
      }

      return {
        messageIds: [...messageIds],
        nextPageToken: page.nextPageToken ?? null,
        historyId: page.historyId ?? null,
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
