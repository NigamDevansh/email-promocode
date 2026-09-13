import type { GmailHeader, GmailMessage, GmailPart, ParsedMessage } from '../types/gmail.js'

/** Gmail encodes part bodies as base64url, not standard base64. */
export function decodeBase64Url(data: string, charset = 'utf-8'): string {
  const normalized = data.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return decodeBytes(bytes, charset)
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    // Unknown or malformed charset label: UTF-8 is the only safe default.
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const match = headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())
  return match?.value ?? ''
}

/** Reads `charset` out of a Content-Type header, e.g. `text/html; charset="UTF-8"`. */
function charsetOf(part: GmailPart): string {
  const contentType = headerValue(part.headers, 'Content-Type')
  const match = /charset\s*=\s*("([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType)
  return (match?.[2] ?? match?.[3] ?? match?.[4] ?? 'utf-8').trim()
}

/** An attachment, not inline body content. */
function isAttachment(part: GmailPart): boolean {
  if (part.body?.attachmentId) return true
  if (part.filename) return true
  return /^attachment\b/i.test(headerValue(part.headers, 'Content-Disposition'))
}

/**
 * Walks the whole MIME tree and concatenates inline text parts by type.
 * Nested multipart/{alternative,mixed,related} all fall out of the recursion;
 * attachments are skipped because phase 7 owns images and PDFs stay out of scope.
 */
export function collectTextParts(payload: GmailPart | undefined): { text: string; html: string } {
  const text: string[] = []
  const html: string[] = []

  const visit = (part: GmailPart | undefined): void => {
    if (!part) return

    // Checked before recursing: a multipart attachment such as a forwarded
    // message/rfc822 would otherwise leak its nested text parts into extraction.
    if (isAttachment(part)) return

    for (const child of part.parts ?? []) visit(child)

    if (!part.body?.data) return

    const mimeType = (part.mimeType ?? '').toLowerCase()
    if (mimeType.startsWith('text/plain')) {
      text.push(decodeBase64Url(part.body.data, charsetOf(part)))
    } else if (mimeType.startsWith('text/html')) {
      html.push(decodeBase64Url(part.body.data, charsetOf(part)))
    }
  }

  visit(payload)
  return { text: text.join('\n'), html: html.join('\n') }
}

/** §9: lowercased domain parsed from the RFC 5322 `From` address. */
export function senderDomainOf(from: string): string {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from
  const domain = address.trim().split('@').at(-1) ?? ''
  return domain.toLowerCase().replace(/[>\s]+$/, '')
}

export function parseGmailMessage(message: GmailMessage): ParsedMessage {
  const headers = message.payload?.headers
  const from = headerValue(headers, 'From')
  const { text, html } = collectTextParts(message.payload)

  return {
    id: message.id,
    threadId: message.threadId,
    internalDate: Number(message.internalDate ?? 0),
    subject: headerValue(headers, 'Subject'),
    from,
    senderDomain: senderDomainOf(from),
    text,
    html,
  }
}
