import type { GmailPort } from '../types/gmail.js'
import type {
  ImageCandidate,
  OcrRecognizeRequest,
  OcrRecognizeResponse,
  OcrResult,
  OcrRun,
} from '../types/ocr.js'
import { isWorthReading } from '../utils/images.js'
import { meanConfidenceOf, usableOcrText } from '../utils/ocr-text.js'

const OFFSCREEN_PATH = 'offscreen/index.html'

/** A banner large enough to hide a whole template; anything bigger is not text. */
const MAX_IMAGE_BYTES = 8_000_000

let creating: Promise<void> | undefined

/**
 * §7 phase 7: the offscreen document exists so bundled Tesseract can spawn its
 * Web Workers, which a service worker cannot do. It is created on demand and
 * left running, because starting the engine costs seconds.
 */
async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  })
  if (existing.length > 0) return

  // Concurrent slices must not race to create two documents; Chrome allows one.
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification: 'Run bundled Tesseract OCR on promotional images to read coupon codes.',
    })
    .finally(() => {
      creating = undefined
    })

  await creating
}

function toDataUrl(bytes: ArrayBuffer, contentType: string): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  // Chunked: spreading a megabyte-long array into apply() overflows the stack.
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000))
  }
  return `data:${contentType};base64,${btoa(binary)}`
}

/**
 * §12 request hygiene: retailer CDNs are fetched with credentials omitted and
 * no referrer. There is no reason to hand them cookies or a trail.
 */
async function fetchRemoteImage(url: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const response = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  }).catch(() => null)

  if (!response?.ok) return null

  const type = response.headers.get('content-type') ?? 'image/png'
  if (!type.startsWith('image/')) return null

  const bytes = await response.arrayBuffer().catch(() => null)
  if (!bytes || bytes.byteLength > MAX_IMAGE_BYTES) return null
  return { bytes, type }
}

async function loadImage(
  candidate: ImageCandidate,
  messageId: string,
  gmail: GmailPort,
): Promise<string | null> {
  if (candidate.source === 'remote') {
    const fetched = await fetchRemoteImage(candidate.ref)
    if (!fetched || !isWorthReading(fetched.bytes.byteLength)) return null
    return toDataUrl(fetched.bytes, fetched.type)
  }

  // Inline parts come back from Gmail as base64url, already authenticated.
  const data = await gmail.getAttachmentData(messageId, candidate.ref).catch(() => '')
  if (!data) return null

  const normalized = data.replaceAll('-', '+').replaceAll('_', '/')
  if (!isWorthReading(Math.floor((normalized.length * 3) / 4))) return null
  return `data:image/png;base64,${normalized}`
}

async function recognize(dataUrl: string): Promise<OcrResult | null> {
  await ensureOffscreenDocument()

  const response = (await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'ocr-recognize',
    dataUrl,
  } satisfies OcrRecognizeRequest)) as OcrRecognizeResponse | undefined

  return response?.ok ? response.result : null
}

/**
 * Reads the chosen images and returns the text worth trusting.
 *
 * §11 does the filtering in `usableOcrText`: a low-confidence read, or one full
 * of confusable glyphs, yields nothing rather than a code that fails at
 * checkout. OCR never throws the message away — a failure here just means the
 * text stages stand alone.
 */
export async function readImages(
  candidates: readonly ImageCandidate[],
  messageId: string,
  gmail: GmailPort,
): Promise<OcrRun> {
  const texts: string[] = []
  const confidences: number[] = []
  let imagesRead = 0

  for (const candidate of candidates) {
    const dataUrl = await loadImage(candidate, messageId, gmail).catch(() => null)
    if (!dataUrl) continue

    const result = await recognize(dataUrl).catch(() => null)
    if (!result) continue

    imagesRead += 1
    const usable = usableOcrText(result)
    confidences.push(result.meanConfidence)
    if (usable) texts.push(usable)
  }

  return {
    imagesConsidered: candidates.length,
    imagesRead,
    imagesAccepted: texts.length,
    meanConfidence: meanConfidenceOf(
      confidences.map((confidence) => ({ text: '', confidence })),
    ),
    text: texts.join(' '),
  }
}
