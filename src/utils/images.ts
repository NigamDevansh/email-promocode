import type { GmailPart } from '../types/gmail.js'
import type { ImageCandidate } from '../types/ocr.js'
import { extractTagAttributes } from './html.js'

/*
 * §7 image handling.
 *
 * Marketing email now puts the code in a rendered banner more often than in
 * text, and the banners carry no usable size attributes — opaque CDN filenames,
 * no width, no height. There is no signal left to rank them by, so this no
 * longer tries: every image that could physically hold a code is a candidate,
 * and `readImages` works through them until it finds a code or runs out of
 * time. Ordering still matters, because the time budget decides how far down
 * the list it gets, but nothing is excluded for merely looking unpromising.
 */

/**
 * A bomb guard, not a selection rule. A legitimate promotional email carries
 * ten to twenty images; anything past this is a template gone wrong or a
 * deliberately hostile message, and the per-message time budget in
 * `readImages` is the real limit either way.
 */
const MAX_IMAGES = 25

/** Template furniture that is never the banner: matched on names, not on size. */
const NAME_BLOCKLIST =
  /(logo|icon|favicon|pixel|spacer|tracking|beacon|divider|separator|bullet|arrow|social|facebook|twitter|instagram|linkedin|youtube|whatsapp|pinterest|appstore|playstore|badge|avatar|signature|footer|header-bg)/i

/** §7: a code is never legible below this, so a declared size this small is out. */
const MIN_WIDTH = 200
const MIN_HEIGHT = 100

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
 * Rejects an image whose declared size is too small to hold a legible code.
 * An image that declares no size is kept: that is now the common case, and
 * guessing against silence is what made the old ranking useless.
 */
function passesDeclaredSize(width: number | null, height: number | null): boolean {
  if (width !== null && width < MIN_WIDTH) return false
  if (height !== null && height < MIN_HEIGHT) return false
  return true
}

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

/**
 * Banners referenced by the HTML body and hosted by the sender.
 *
 * §12: fetching one of these registers an open with the sender. That is the
 * accepted cost of reading image-only coupons at all — the popup discloses it
 * rather than the extension pretending it does not happen.
 */
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

/**
 * Known size within one source, used to order the queue rather than to trim it.
 *
 * Gmail reports a part's bytes and never its dimensions; HTML declares
 * dimensions and never bytes. The two are not comparable, which is why the
 * sort settles source before it ever calls this. Unknown size sorts last: a
 * declared size is evidence, its absence is not — but an unranked image is
 * still read, just later.
 */
function rankWithinSource(image: ImageCandidate): number {
  return (image.source === 'inline' ? image.byteSize : image.pixelArea) ?? -1
}

/**
 * Every image in the message that could hold a code, best guess first.
 *
 * Inline parts come first: Gmail already served them, so they cost the sender
 * nothing and tell them nothing. Remote banners follow, and the whole list is
 * attempted — the caller's time budget, not a top-N cut, decides where reading
 * actually stops.
 */
export function selectOcrImages(
  html: string,
  payload: GmailPart | undefined,
  limit: number = MAX_IMAGES,
): ImageCandidate[] {
  return [...inlineImageParts(payload), ...remoteImageCandidates(html)]
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
