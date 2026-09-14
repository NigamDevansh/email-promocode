import type {
  CollectedText,
  ExternalTextPart,
  GmailHeader,
  GmailMessage,
  GmailPart,
  ParsedMessage,
} from '../types/gmail.js'

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

/** `attachmentId` alone can mean an externalized body, so do not use it here. */
function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true
  return /^attachment\b/i.test(headerValue(part.headers, 'Content-Disposition'))
}

function textKindOf(part: GmailPart): 'text' | 'html' | null {
  const mimeType = (part.mimeType ?? '').toLowerCase()
  if (mimeType.startsWith('text/plain')) return 'text'
  if (mimeType.startsWith('text/html')) return 'html'
  return null
}

/** Walks nested MIME parts, collecting inline text while skipping attachments. */
export function collectTextParts(payload: GmailPart | undefined): CollectedText {
  const text: string[] = []
  const html: string[] = []
  const external: ExternalTextPart[] = []

  const visit = (part: GmailPart | undefined): void => {
    if (!part) return

    // Checked before recursing: a multipart attachment such as a forwarded
    // message/rfc822 would otherwise leak its nested text parts into extraction.
    if (isAttachment(part)) return

    for (const child of part.parts ?? []) visit(child)

    const kind = textKindOf(part)
    if (!kind) return

    if (part.body?.data) {
      const decoded = decodeBase64Url(part.body.data, charsetOf(part))
      ;(kind === 'text' ? text : html).push(decoded)
      return
    }

    // Body externalized by Gmail; the runtime fetches it before extraction.
    if (part.body?.attachmentId) {
      external.push({ attachmentId: part.body.attachmentId, kind, charset: charsetOf(part) })
    }
  }

  visit(payload)
  return { text: text.join('\n'), html: html.join('\n'), external }
}

/** Fetches and merges text bodies Gmail did not inline in the message payload. */
export async function hydrateExternalParts(
  collected: CollectedText,
  fetchAttachmentData: (attachmentId: string) => Promise<string>,
): Promise<{ text: string; html: string }> {
  let { text, html } = collected

  for (const part of collected.external) {
    const decoded = decodeBase64Url(await fetchAttachmentData(part.attachmentId), part.charset)
    if (part.kind === 'text') text = text ? `${text}\n${decoded}` : decoded
    else html = html ? `${html}\n${decoded}` : decoded
  }

  return { text, html }
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
  const { text, html, external } = collectTextParts(message.payload)

  return {
    id: message.id,
    threadId: message.threadId,
    internalDate: Number(message.internalDate ?? 0),
    subject: headerValue(headers, 'Subject'),
    from,
    senderDomain: senderDomainOf(from),
    text,
    html,
    externalParts: external,
  }
}
