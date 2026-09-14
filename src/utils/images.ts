import type { GmailPart } from '../types/gmail.js'
import type { ImageCandidate } from '../types/ocr.js'
import { extractTagAttributes } from './html.js'

/*
 * §7 image handling. OCR is the last and slowest stage, so the filtering here
 * exists to make sure it runs on the one banner that might carry a code rather
 * than on every logo, spacer and tracking pixel in a marketing template.
 */

/** §7: drop anything smaller than this; a code is never legible below it. */
const MIN_WIDTH = 200
const MIN_HEIGHT = 100

/** §7: at most the largest one or two by area — the hero banner carries the code. */
const MAX_IMAGES = 2

/** Template furniture that is never the hero banner. */
const NAME_BLOCKLIST =
  /(logo|icon|favicon|pixel|spacer|tracking|beacon|divider|separator|bullet|arrow|social|facebook|twitter|instagram|linkedin|youtube|whatsapp|pinterest|appstore|playstore|badge|avatar|signature|footer|header-bg)/i

function numberAttribute(value: string | undefined): number | null {
  if (!value) return null
  // Accepts "600" and "600px"; rejects "100%" since it says nothing absolute.
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

/**
 * Rejects an image whose declared size is too small. An image that declares no
 * size is kept: marketing templates often omit dimensions, and the byte-size
 * check after fetching catches the rest.
 */
function passesDeclaredSize(width: number | null, height: number | null): boolean {
  if (width !== null && width < MIN_WIDTH) return false
  if (height !== null && height < MIN_HEIGHT) return false
  return true
}

/** Images embedded in the message itself, served by Google with no tracking impact. */
export function inlineImageParts(payload: GmailPart | undefined): ImageCandidate[] {
  const found: ImageCandidate[] = []

  const visit = (part: GmailPart | undefined): void => {
    if (!part) return
    for (const child of part.parts ?? []) visit(child)

    const mimeType = (part.mimeType ?? '').toLowerCase()
    if (!mimeType.startsWith('image/') || !part.body?.attachmentId) return
    if (part.filename && NAME_BLOCKLIST.test(part.filename)) return

    found.push({
      source: 'inline',
      ref: part.body.attachmentId,
      width: null,
      height: null,
      pixelArea: null,
      byteSize: part.body.size ?? null,
      alt: part.filename ?? '',
    })
  }

  visit(payload)
  return found
}

/** Remote banners referenced by the HTML body. */
export function remoteImageCandidates(html: string): ImageCandidate[] {
  const found: ImageCandidate[] = []

  for (const attributes of extractTagAttributes(html, 'img')) {
    const src = attributes['src'] ?? ''
    if (!/^https?:\/\//i.test(src)) continue
    if (looksLikeFurniture(attributes)) continue

    const width = numberAttribute(attributes['width'])
    const height = numberAttribute(attributes['height'])
    if (!passesDeclaredSize(width, height)) continue

    found.push({
      source: 'remote',
      ref: src,
      width,
      height,
      pixelArea: width !== null && height !== null ? width * height : null,
      byteSize: null,
      alt: attributes['alt'] ?? '',
    })
  }

  return found
}

/**
 * Size within one source. Gmail reports a part's bytes and never its
 * dimensions; HTML declares dimensions and never bytes. The two are not
 * comparable, which is why the sort settles source before it ever calls this.
 *
 * Unknown size ranks last: a declared size is evidence, its absence is not.
 */
function rankWithinSource(image: ImageCandidate): number {
  return (image.source === 'inline' ? image.byteSize : image.pixelArea) ?? -1
}

/**
 * The images worth reading, largest first.
 *
 * Inline parts sort ahead of remote ones at equal rank: they cost the sender
 * nothing to serve and tell them nothing about you.
 */
export function selectOcrImages(
  html: string,
  payload: GmailPart | undefined,
  limit: number = MAX_IMAGES,
): ImageCandidate[] {
  const all = [...inlineImageParts(payload), ...remoteImageCandidates(html)]

  return all
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === 'inline' ? -1 : 1
      // Source is settled first, so rank only ever compares like with like:
      // bytes against bytes for inline parts, pixels against pixels for remote.
      return rankWithinSource(right) - rankWithinSource(left)
    })
    .slice(0, limit)
}

/** §7: below roughly this, a fetched image cannot hold legible text. */
export const MIN_IMAGE_BYTES = 6_000

export function isWorthReading(bytes: number): boolean {
  return bytes >= MIN_IMAGE_BYTES
}
