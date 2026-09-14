import type {
  Candidate,
  CandidateSource,
  GateResult,
  TriggerContext,
} from '../types/extraction.js'
import type { ParsedMessage } from '../types/gmail.js'
import { extractAltTexts, extractHrefs, extractVisibleText } from './html.js'

/** Query parameters that carry a coupon code directly. */
const COUPON_PARAMS = new Set([
  'coupon',
  'couponcode',
  'coupon_code',
  'code',
  'promo',
  'promocode',
  'promo_code',
  'promotion_code',
  'discount',
  'discountcode',
  'discount_code',
  'voucher',
  'vouchercode',
  'offer',
  'offercode',
  'cpn',
])

/** Redirect keys followed exactly one level deep. */
const REDIRECT_PARAMS = new Set([
  'url',
  'u',
  'r',
  'redirect',
  'redirect_url',
  'dest',
  'destination',
  'target',
  'link',
  'to',
])

const TRIGGER_PHRASES = [
  'use code',
  'using code',
  'with code',
  'apply code',
  'enter code',
  'coupon code',
  'promo code',
  'promotion code',
  'discount code',
  'voucher code',
  'offer code',
  'code:',
]

/** Exact false-positive terms; a code such as MONSOON40 remains valid. */
const BLOCKLIST = new Set([
  'ACCOUNT', 'ANDROID', 'ARRIVALS', 'BESTSELLER', 'BROWSER', 'CANCEL', 'CART',
  'CHECKOUT', 'CLICK', 'COLLECTION', 'CONDITIONS', 'CONTACT', 'COPYRIGHT',
  'DELIVERY', 'DISCOUNT', 'DOWNLOAD', 'EMAIL', 'EXCHANGE', 'EXCLUSIVE',
  'FACEBOOK', 'FEATURED', 'GOOGLE', 'HELVETICA', 'HERE', 'HURRY', 'INSTAGRAM',
  'INVOICE', 'IPHONE', 'LIMITED', 'LINKEDIN', 'LOGIN', 'LOWEST', 'NEWSLETTER',
  'ONLINE', 'ORDER', 'ORDERS', 'PINTEREST', 'POLICY', 'PREFERENCES', 'PRICES',
  'PRIVACY', 'PRODUCTS', 'RECEIPT', 'REGISTER', 'RESERVED', 'RETURNS', 'RIGHTS',
  'SETTINGS', 'SHIPPING', 'SHOPNOW', 'SIGNIN', 'SIGNUP', 'SUBSCRIBE', 'SUPPORT',
  'TERMS', 'TODAY', 'TONIGHT', 'TRACKING', 'TRENDING', 'TWITTER', 'UNSUBSCRIBE',
  'VIEW', 'WEEKEND', 'WHATSAPP', 'WISHLIST', 'YOUTUBE',
])

/** Token shape scanned out of free text; casing is judged separately below. */
const CODE_SHAPE = /\b[A-Za-z0-9][A-Za-z0-9_-]{3,19}\b/g

/** Full-value matching prevents link-parameter prose from becoming a candidate. */
const STRICT_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,19}$/

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase()
}

/** Applies the casing and trigger rules that separate codes from headline text. */
function isAcceptableCode(
  raw: string,
  normalized: string,
  source: CandidateSource,
  context: TriggerContext,
): boolean {
  if (BLOCKLIST.has(normalized)) return false
  if (!/[A-Z]/.test(normalized)) return false
  if (!/[A-Z0-9]$/.test(normalized)) return false

  if (source === 'link') return true

  const hasDigit = /[0-9]/.test(normalized)
  if (raw !== raw.toUpperCase()) return hasDigit && context.afterTrigger
  return hasDigit || (context.afterTrigger && normalized.length >= 5)
}

/** Coupon language must occur before a free-text code. */
function triggerContext(offsets: number[], at: number): TriggerContext {
  return {
    afterTrigger: offsets.some((offset) => at >= offset && at - offset <= 30),
    nearTrigger: offsets.some((offset) => Math.abs(at - offset) <= 40),
  }
}

/** Offsets just past each trigger phrase occurrence. */
function triggerOffsets(haystack: string): number[] {
  const lower = haystack.toLowerCase()
  const offsets: number[] = []

  for (const phrase of TRIGGER_PHRASES) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(phrase, from)
      if (at === -1) break
      offsets.push(at + phrase.length)
      from = at + phrase.length
    }
  }
  return offsets
}

function scoreFor(source: CandidateSource, normalized: string, nearTrigger: boolean): number {
  let score = 0
  if (source === 'link') score += 3
  if (source === 'alt') score += 2
  if (source === 'subject') score += 2
  if (nearTrigger) score += 3
  if (/[A-Z]/.test(normalized) && /[0-9]/.test(normalized)) score += 1
  if (normalized.length >= 5 && normalized.length <= 12) score += 1
  if (normalized.length > 15) score -= 1
  return score
}

/** Pulls coupon parameters out of one URL, following redirect keys one level. */
function codesFromUrl(href: string, depth = 0): string[] {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return []
  }

  const found: string[] = []
  for (const [key, value] of url.searchParams) {
    const lowerKey = key.toLowerCase()

    if (COUPON_PARAMS.has(lowerKey)) {
      const trimmed = value.trim()
      if (STRICT_CODE.test(trimmed)) found.push(trimmed)
      continue
    }

    if (depth === 0 && REDIRECT_PARAMS.has(lowerKey) && value) {
      found.push(...codesFromUrl(value, depth + 1))
    }
  }
  return found
}

function collect(
  into: Map<string, Candidate>,
  code: string,
  source: CandidateSource,
  context: TriggerContext,
): void {
  const raw = code.trim()
  const normalized = normalizeCode(raw)
  if (!isAcceptableCode(raw, normalized, source, context)) return

  const score = scoreFor(source, normalized, context.nearTrigger)
  const existing = into.get(normalized)
  if (!existing || score > existing.score) {
    into.set(normalized, { code: code.trim(), normalized, source, score })
  }
}

/** Scans free text for code-shaped tokens, scoring proximity to a trigger phrase. */
function collectFromText(
  into: Map<string, Candidate>,
  haystack: string,
  source: CandidateSource,
): void {
  if (!haystack) return
  const offsets = triggerOffsets(haystack)

  for (const match of haystack.matchAll(CODE_SHAPE)) {
    collect(into, match[0], source, triggerContext(offsets, match.index))
  }
}

/**
 * Uses link, alt, subject, text, and optional OCR signals to decide whether a
 * message warrants LLM extraction. OCR candidates remain flagged for review.
 */
export function gateMessage(message: ParsedMessage, ocrText = ''): GateResult {
  const candidates = new Map<string, Candidate>()

  for (const href of extractHrefs(message.html)) {
    for (const code of codesFromUrl(href)) {
      collect(candidates, code, 'link', { afterTrigger: true, nearTrigger: true })
    }
  }

  const alts = extractAltTexts(message.html)
  for (const alt of alts) collectFromText(candidates, alt, 'alt')

  collectFromText(candidates, message.subject, 'subject')

  // Multipart email often has a generic text stub beside code-bearing HTML.
  const visible = extractVisibleText(message.html)
  collectFromText(candidates, message.text, 'text')
  collectFromText(candidates, visible, 'text')
  collectFromText(candidates, ocrText, 'ocr')

  const hasTriggerPhrase = [message.subject, message.text, visible, ocrText, ...alts].some(
    (haystack) => triggerOffsets(haystack).length > 0,
  )

  return {
    candidates: [...candidates.values()].sort(
      (a, b) => b.score - a.score || a.normalized.localeCompare(b.normalized),
    ),
    hasTriggerPhrase,
    shouldExtract: candidates.size > 0 || hasTriggerPhrase,
  }
}
