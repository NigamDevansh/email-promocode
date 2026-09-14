/** Small, browser-independent scanners for promotional-email HTML. */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  pound: '£',
  euro: '€',
  yen: '¥',
  cent: '¢',
}

/** Decodes numeric (decimal and hex) plus the named entities common in promo mail. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Reads one attribute off every matching tag. Supports double-quoted,
 * single-quoted and unquoted values, which ESP-generated markup mixes freely.
 */
function attributeValues(html: string, tag: string, attribute: string): string[] {
  // Whitespace before the name, not \b: `-` to `a` is a word boundary, so \b
  // would read data-alt as alt and data-href as href.
  const pattern = new RegExp(
    `<${tag}\\b[^>]*?\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'gi',
  )
  const values: string[] = []

  for (const match of stripNonContent(html).matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[3]
    if (raw === undefined) continue
    const value = decodeEntities(raw).trim()
    if (value) values.push(value)
  }
  return values
}

/** Removes markup that cannot contribute visible content or attributes. */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/i, ' ')
}

/** Anchor targets, for the link-parameter stage. */
export function extractHrefs(html: string): string[] {
  return attributeValues(html, 'a', 'href')
}

/** Image alt text — ESPs generate it from the design layer, so banners often carry their own code. */
export function extractAltTexts(html: string): string[] {
  return attributeValues(html, 'img', 'alt')
}

/**
 * Best-effort visible text. Tags collapse to a space rather than nothing, so
 * adjacent elements cannot fuse a label onto a code ("use code" + "SAVE20").
 */
export function extractVisibleText(html: string): string {
  return decodeEntities(
    stripNonContent(html).replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Every attribute of every matching tag, grouped per tag.
 *
 * `attributeValues` above loses which tag a value came from, which is fine for
 * collecting alt text but useless for choosing an image: the decision needs
 * src, width, height and class together on the same element.
 */
export function extractTagAttributes(html: string, tag: string): Record<string, string>[] {
  const tags = new RegExp(`<${tag}\\b([^>]*)>`, 'gi')
  const attribute = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

  // Same stripping as every other scanner here: ESP templates park whole
  // `<img>` blocks inside MSO conditional comments, and an image nobody is
  // shown must not cost a CDN fetch or one of the two OCR slots.
  return [...stripNonContent(html).matchAll(tags)].map((match) => {
    const attributes: Record<string, string> = {}
    for (const found of (match[1] ?? '').matchAll(attribute)) {
      const name = (found[1] ?? '').toLowerCase()
      const raw = found[2] ?? found[3] ?? found[4] ?? ''
      if (name) attributes[name] = decodeEntities(raw).trim()
    }
    return attributes
  })
}
