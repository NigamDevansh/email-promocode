import type { GmailPart } from '../types/gmail.js'
import type { ImageCandidate } from '../types/ocr.js'

/*
 * §7 image handling. OCR is the last and slowest stage, so the filtering here
 * exists to make sure it runs on the one banner that might carry a code rather
 * than on every logo, spacer and tracking pixel in a marketing template.
 */

/** §7: at most the largest one or two by area — the hero banner carries the code. */
const MAX_IMAGES = 2

/** Template furniture that is never the hero banner. */
const NAME_BLOCKLIST =
  /(logo|icon|favicon|pixel|spacer|tracking|beacon|divider|separator|bullet|arrow|social|facebook|twitter|instagram|linkedin|youtube|whatsapp|pinterest|appstore|playstore|badge|avatar|signature|footer|header-bg)/i

/** Images embedded in the message itself, served by Gmail with no tracking impact. */
export function inlineImageParts(payload: GmailPart | undefined): ImageCandidate[] {
  const found: ImageCandidate[] = []

  const visit = (part: GmailPart | undefined): void => {
    if (!part) return
    for (const child of part.parts ?? []) visit(child)

    const mimeType = (part.mimeType ?? '').toLowerCase()
    if (!mimeType.startsWith('image/') || (!part.body?.attachmentId && !part.body?.data)) return
    if (part.filename && NAME_BLOCKLIST.test(part.filename)) return

    found.push({
      source: 'inline',
      attachmentId: part.body.attachmentId ?? null,
      data: part.body.data ?? null,
      width: null,
      height: null,
      pixelArea: null,
      byteSize: part.body.size ?? null,
      mimeType,
    })
  }

  visit(payload)
  return found
}

/**
 * The largest inline images worth reading, first. Remote images deliberately
 * stay out of this MVP: fetching an email's CDN banner registers an open with
 * its sender and would require a separate, explicit permission flow.
 */
export function selectOcrImages(
  payload: GmailPart | undefined,
  limit: number = MAX_IMAGES,
): ImageCandidate[] {
  return inlineImageParts(payload)
    .sort((left, right) => (right.byteSize ?? -1) - (left.byteSize ?? -1))
    .slice(0, limit)
}

/** §7: below roughly this, a fetched image cannot hold legible text. */
export const MIN_IMAGE_BYTES = 6_000

export function isWorthReading(bytes: number): boolean {
  return bytes >= MIN_IMAGE_BYTES
}
