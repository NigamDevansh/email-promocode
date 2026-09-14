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

/** Total time one message may spend in OCR, however many images it offers. */
const MESSAGE_BUDGET_MS = 60_000

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

async function loadImage(
  candidate: ImageCandidate,
  messageId: string,
  gmail: GmailPort,
): Promise<string | null> {
  if (candidate.byteSize !== null && candidate.byteSize > MAX_IMAGE_BYTES) return null

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
  return `data:${candidate.mimeType};base64,${normalized}`
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
    // One slow image must not spend the budget the next message needs.
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
