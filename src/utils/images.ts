import type { GmailPart } from '../types/gmail.js'
import type { ImageCandidate } from '../types/ocr.js'
import { extractTagAttributes } from './html.js'

/** Caps pathological templates; message-level OCR timing remains the real budget. */
const MAX_IMAGES = 25

/** Template furniture, matched by name rather than size. */
const NAME_BLOCKLIST =
  /(logo|icon|favicon|pixel|spacer|tracking|beacon|divider|separator|bullet|arrow|social|facebook|twitter|instagram|linkedin|youtube|whatsapp|pinterest|appstore|playstore|badge|avatar|signature|footer|header-bg)/i

/** Declared dimensions too small for a legible code. */
const MIN_WIDTH = 200
const MIN_HEIGHT = 100

function numberAttribute(value: string | undefined): number | null {
  if (!value) return null
  // Percentage dimensions provide no useful absolute size signal.
  const match = /^(\d+)(?:px)?$/i.exec(value.trim())
  return match ? Number(match[1]) : null
}

function looksLikeFurniture(attributes: Record<string, string>): boolean {
  const haystack = [
    attributes['src'] ?? '',
    attributes['class'] ?? '',
    attributes['id'] ?? '',
    attributes['alt'] ?? '',
  ].join(' ')
  return NAME_BLOCKLIST.test(haystack)
}

/** Unknown dimensions are retained; only known-impossible images are rejected. */
function passesDeclaredSize(width: number | null, height: number | null): boolean {
  if (width !== null && width < MIN_WIDTH) return false
  if (height !== null && height < MIN_HEIGHT) return false
  return true
}

/** Images embedded in the message itself. */
export function inlineImageParts(payload: GmailPart | undefined): ImageCandidate[] {
  const found: ImageCandidate[] = []

  const visit = (part: GmailPart | undefined): void => {
    if (!part) return
    for (const child of part.parts ?? []) visit(child)

    const mimeType = (part.mimeType ?? '').toLowerCase()
    if (!mimeType.startsWith('image/') || (!part.body?.attachmentId && !part.body?.data)) return
    if (part.filename && NAME_BLOCKLIST.test(part.filename)) return
    if (part.body.size !== undefined && !isWorthReading(part.body.size)) return

    found.push({
      source: 'inline',
      attachmentId: part.body.attachmentId ?? null,
      data: part.body.data ?? null,
      url: null,
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

/** Banners referenced by the HTML body and hosted by the sender. */
export function remoteImageCandidates(html: string): ImageCandidate[] {
  const found: ImageCandidate[] = []
  const seen = new Set<string>()

  for (const attributes of extractTagAttributes(html, 'img')) {
    const src = attributes['src'] ?? ''
    if (!/^https?:\/\//i.test(src)) continue
    if (seen.has(src)) continue
    if (looksLikeFurniture(attributes)) continue

    const width = numberAttribute(attributes['width'])
    const height = numberAttribute(attributes['height'])
    if (!passesDeclaredSize(width, height)) continue

    seen.add(src)
    found.push({
      source: 'remote',
      attachmentId: null,
      data: null,
      url: src,
      width,
      height,
      pixelArea: width !== null && height !== null ? width * height : null,
      byteSize: null,
      mimeType: null,
    })
  }

  return found
}

/** Known sizes rank images within their source; unknown sizes sort last. */
function rankWithinSource(image: ImageCandidate): number {
  return (image.source === 'inline' ? image.byteSize : image.pixelArea) ?? -1
}

/** Every viable image, with inline Gmail parts first and no speculative top-N cut. */
export function selectOcrImages(
  html: string,
  payload: GmailPart | undefined,
  limit: number = MAX_IMAGES,
): ImageCandidate[] {
  return [...inlineImageParts(payload), ...remoteImageCandidates(html)]
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === 'inline' ? -1 : 1
      return rankWithinSource(right) - rankWithinSource(left)
    })
    .slice(0, limit)
}

/** §7: below roughly this, a fetched image cannot hold legible text. */
export const MIN_IMAGE_BYTES = 6_000

export function isWorthReading(bytes: number): boolean {
  return bytes >= MIN_IMAGE_BYTES
}
