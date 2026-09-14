/** Subset of the Gmail `messages.get?format=full` response the extractor reads. */
export interface GmailHeader {
  name: string
  value: string
}

export interface GmailBody {
  attachmentId?: string
  size?: number
  /** base64url, present for inline part content. */
  data?: string
}

export interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: GmailBody
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  /** Milliseconds since epoch, as a string. */
  internalDate?: string
  labelIds?: string[]
  payload?: GmailPart
}

export interface GmailMessageRef {
  id: string
  threadId: string
}

export interface GmailListResponse {
  messages?: GmailMessageRef[]
  nextPageToken?: string
}

export interface GmailMetadataResponse {
  id: string
  threadId: string
  internalDate?: string
  payload?: { headers?: GmailHeader[] }
}

export interface GmailAttachmentResponse {
  data?: string
}

export interface GmailPage {
  ids: string[]
  nextPageToken: string | null
}

/** A text body Gmail stored separately because it was too large to inline. */
export interface ExternalTextPart {
  attachmentId: string
  kind: 'text' | 'html'
  charset: string
}

export interface CollectedText {
  text: string
  html: string
  external: ExternalTextPart[]
}

/** A message reduced to the text surfaces the free extraction stages read. */
export interface ParsedMessage {
  id: string
  threadId: string
  /** Milliseconds since epoch. */
  internalDate: number
  subject: string
  from: string
  senderDomain: string
  text: string
  html: string
  /** Empty unless Gmail externalized a body part; hydrate before extraction. */
  externalParts: ExternalTextPart[]
}

/** Gmail boundary the backfill runner depends on, so tests need no network. */
export interface GmailPort {
  listPage(options: {
    newerThanDays: number
    pageToken: string | null
    pageSize: number
  }): Promise<GmailPage>
  getFull(messageId: string): Promise<GmailMessage>
  /** Raw base64url `data` for one externalized body part. */
  getAttachmentData(messageId: string, attachmentId: string): Promise<string>
}
