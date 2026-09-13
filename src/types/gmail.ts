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
}
