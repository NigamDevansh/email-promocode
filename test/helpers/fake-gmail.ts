import type { GmailMessage, GmailPort } from '../../src/types/gmail.ts'
import { GmailApiError } from '../../src/background/gmail.ts'

export const b64url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')

export function textMessage(id: string, body: string): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: '1757600000000',
    labelIds: ['CATEGORY_PROMOTIONS'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `Sender <mail@e.${id}.example>` },
        { name: 'Subject', value: `Subject for ${id}` },
        { name: 'Content-Type', value: 'text/plain; charset="utf-8"' },
      ],
      body: { size: body.length, data: b64url(body) },
    },
  }
}

/** A text/html body Gmail stored separately because it was too large to inline. */
export function externalizedHtmlMessage(id: string, attachmentId: string): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: '1757600000000',
    labelIds: ['CATEGORY_PROMOTIONS'],
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: `Sender <mail@e.${id}.example>` },
        { name: 'Subject', value: `Subject for ${id}` },
      ],
      body: { size: 0 },
      parts: [
        {
          mimeType: 'text/html',
          headers: [{ name: 'Content-Type', value: 'text/html; charset="utf-8"' }],
          body: { attachmentId, size: 400_000 },
        },
      ],
    },
  }
}

export interface FakeGmail extends GmailPort {
  fullCalls: string[]
  listCalls: (string | null)[]
  attachmentCalls: string[]
  /** Message IDs that should throw when fetched. */
  failing: Set<string>
  attachments: Map<string, string>
}

export function createFakeGmail(pages: string[][], messages: Map<string, GmailMessage>): FakeGmail {
  const fake: FakeGmail = {
    fullCalls: [],
    listCalls: [],
    attachmentCalls: [],
    failing: new Set(),
    attachments: new Map(),

    async listPage({ pageToken }) {
      fake.listCalls.push(pageToken)
      const index = pageToken === null ? 0 : Number(pageToken)
      const ids = pages[index] ?? []
      return { ids, nextPageToken: index + 1 < pages.length ? String(index + 1) : null }
    },

    async getFull(messageId) {
      fake.fullCalls.push(messageId)
      if (fake.failing.has(messageId)) {
        throw new GmailApiError(500, messageId, 'fixture failure')
      }
      const message = messages.get(messageId)
      if (!message) throw new Error(`no fixture for ${messageId}`)
      return message
    },

    async getAttachmentData(_messageId, attachmentId) {
      fake.attachmentCalls.push(attachmentId)
      return fake.attachments.get(attachmentId) ?? ''
    },
  }

  return fake
}
