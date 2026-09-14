import type { GmailPort } from '../types/gmail.js'
import type {
  ImageCandidate,
  OcrRecognizeRequest,
  OcrRecognizeResponse,
  OcrResult,
  OcrRun,
} from '../types/ocr.js'
import { isWorthReading } from '../utils/images.js'
import { meanOf, usableOcrText } from '../utils/ocr-text.js'

const OFFSCREEN_PATH = 'offscreen/index.html'

/** A banner large enough to hide a whole template; anything bigger is not text. */
const MAX_IMAGE_BYTES = 8_000_000

/**
 * §7: OCR is slow by nature, but it is not allowed to be unbounded. Tesseract
 * runs in another context behind a message port, so a hung engine would
 * otherwise stall the whole sync slice with nothing to time it out.
 */
const RECOGNIZE_TIMEOUT_MS = 30_000

/**
 * Total time one message may spend in OCR, however many images it offers.
 *
 * Nothing is pre-selected any more, so this is what actually bounds the work:
 * the reader walks the whole image list best-guess-first and stops here. A
 * template with fifteen banners gets as many of them read as ninety seconds
 * allows, which in practice is all of them.
 */
const MESSAGE_BUDGET_MS = 90_000

let creating: Promise<void> | undefined

function offscreenFilter(): chrome.runtime.ContextFilter {
  return {
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  }
}

/**
 * §7 phase 7: the offscreen document exists so bundled Tesseract can spawn its
 * Web Workers, which a service worker cannot do. It is created on demand and
 * kept warm for the rest of the slice, because starting the engine costs
 * seconds; `closeOcrEngine` tears it down once the queue is idle.
 */
async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts(offscreenFilter())
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

/**
 * §7: closes the document and, with it, the Tesseract worker and its ~11MB of
 * engine and language data. Called when a sync slice finishes, so an extension
 * that read one banner this morning is not still holding the engine tonight.
 */
export async function closeOcrEngine(): Promise<void> {
  // A create that is still in flight would otherwise resolve into an orphan.
  if (creating) await creating.catch(() => undefined)

  const existing = await chrome.runtime.getContexts(offscreenFilter()).catch(() => [])
  if (existing.length === 0) return

  await chrome.offscreen.closeDocument().catch(() => undefined)
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
 * §12 request hygiene: the sender's host is contacted with credentials omitted
 * and no referrer. Fetching at all tells them the message was opened — that is
 * the accepted, disclosed cost of reading a code that exists only as pixels —
 * but there is no reason to hand them cookies or a trail on top of it.
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
  if (!isWorthReading(bytes.byteLength)) return null
  return { bytes, type }
}

async function loadImage(
  candidate: ImageCandidate,
  messageId: string,
  gmail: GmailPort,
): Promise<string | null> {
  if (candidate.byteSize !== null && candidate.byteSize > MAX_IMAGE_BYTES) return null

  if (candidate.source === 'remote') {
    if (!candidate.url) return null
    const fetched = await fetchRemoteImage(candidate.url)
    return fetched ? toDataUrl(fetched.bytes, fetched.type) : null
  }

  // Gmail either embeds a small part directly or returns an attachment ID.
  // Both forms are already authenticated Gmail data; neither reaches a sender.
  const data = candidate.data ?? (
    candidate.attachmentId
      ? await gmail.getAttachmentData(messageId, candidate.attachmentId).catch(() => '')
      : ''
  )
  if (!data) return null

  const normalized = data.replaceAll('-', '+').replaceAll('_', '/')
  const estimatedBytes = Math.floor((normalized.length * 3) / 4)
  if (estimatedBytes > MAX_IMAGE_BYTES || !isWorthReading(estimatedBytes)) return null
  return `data:${candidate.mimeType ?? 'image/png'};base64,${normalized}`
}

/** Resolves to null rather than hanging when the engine stops answering. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

async function recognize(dataUrl: string): Promise<OcrResult | null> {
  await ensureOffscreenDocument()

  const response = await withTimeout(
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'ocr-recognize',
      dataUrl,
    } satisfies OcrRecognizeRequest) as Promise<OcrRecognizeResponse | undefined>,
    RECOGNIZE_TIMEOUT_MS,
  )

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
  const deadline = Date.now() + MESSAGE_BUDGET_MS
  let imagesRead = 0

  for (const candidate of candidates) {
    // Nothing was filtered out up front, so this is the only stop condition:
    // one slow message must not spend the budget the next one needs.
    if (Date.now() >= deadline) break

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
    meanConfidence: meanOf(confidences),
    text: texts.join(' '),
  }
}
