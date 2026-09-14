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

/** §7: a short allowlist of redirect keys, followed exactly one level deep. */
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

/**
 * §7 tuning order puts the blocklist first: run a backfill, dump every
 * high-scoring candidate that was junk, and add those words here. Matching is
 * exact, so a real code built on a blocked word still survives — MONSOON is
 * rejected while MONSOON40 is kept.
 */
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

/**
 * A link parameter must match this over its whole value. Without the anchors a
 * value like `?coupon=IGNORE PREVIOUS INSTRUCTIONS A1` becomes a candidate and
 * is handed to the model as source-backed text — the §12 injection surface.
 */
const STRICT_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,19}$/

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase()
}

/**
 * Decides whether a shape-matching token can be a coupon code.
 *
 * The casing rules matter more than the shape. All-caps with no digit is
 * indistinguishable from a headline word — AUTUMN FASHION REWARDS would open
 * the gate on every marketing banner — so it needs explicit coupon language.
 * Mixed case (Save20) is a real but much rarer form, so it needs both a digit
 * and that language before it counts.
 */
function isAcceptableCode(
  raw: string,
  normalized: string,
  source: CandidateSource,
  context: TriggerContext,
): boolean {
  if (BLOCKLIST.has(normalized)) return false
  if (!/[A-Z]/.test(normalized)) return false
  if (!/[A-Z0-9]$/.test(normalized)) return false

  // Link parameters already passed STRICT_CODE over the whole value.
  if (source === 'link') return true

  const hasDigit = /[0-9]/.test(normalized)
  if (raw !== raw.toUpperCase()) return hasDigit && context.afterTrigger
  return hasDigit || (context.afterTrigger && normalized.length >= 5)
}

/** Codes follow coupon language rather than preceding it, so acceptance is directional. */
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
 * Runs the three free extraction stages of §7 and decides whether this message
 * is worth an LLM call. Cheapest signal first: link parameters, then alt text,
 * then body regex.
 */
export function gateMessage(message: ParsedMessage): GateResult {
  const candidates = new Map<string, Candidate>()

  for (const href of extractHrefs(message.html)) {
    for (const code of codesFromUrl(href)) {
      collect(candidates, code, 'link', { afterTrigger: true, nearTrigger: true })
    }
  }

  const alts = extractAltTexts(message.html)
  for (const alt of alts) collectFromText(candidates, alt, 'alt')

  collectFromText(candidates, message.subject, 'subject')

  // Both surfaces, never one or the other: a multipart/alternative message
  // often carries a generic plain-text stub ("view this email in your browser")
  // beside HTML that holds the actual code. The candidate map deduplicates.
  const visible = extractVisibleText(message.html)
  collectFromText(candidates, message.text, 'text')
  collectFromText(candidates, visible, 'text')

  // Alt text counts here too: an image-only email whose banner says "use code"
  // must still reach the LLM even when no candidate survives the shape filter.
  const hasTriggerPhrase = [message.subject, message.text, visible, ...alts].some(
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
