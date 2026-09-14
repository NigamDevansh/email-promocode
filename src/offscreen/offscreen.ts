import { createWorker, type Worker } from 'tesseract.js'
import type {
  OcrRecognizeRequest,
  OcrRecognizeResponse,
  OcrResult,
  RgbaImage,
} from '../types/ocr.js'
import { meanConfidenceOf } from '../utils/ocr-text.js'
import { preprocess } from '../utils/preprocess.js'

/*
 * §2: DOMParser and OffscreenCanvas image decoding do not exist in a service
 * worker, and a service worker cannot spawn the Web Workers Tesseract needs.
 * That is the whole reason this document exists.
 *
 * §7: the engine and language data are loaded from the extension's own files.
 * MV3 blocks remotely hosted code at runtime, so nothing here may reach a CDN.
 */
const vendored = (file: string): string => chrome.runtime.getURL(`vendor/tesseract/${file}`)

let workerPromise: Promise<Worker> | undefined

/** One engine per document. Starting it costs seconds; keep it warm. */
function engine(): Promise<Worker> {
  workerPromise ??= createWorker('eng', 1, {
    workerPath: vendored('worker.min.js'),
    // Pinned to the exact vendored build: letting Tesseract pick a variant
    // would have it request a file this extension does not ship.
    corePath: vendored('tesseract-core-simd-lstm.wasm.js'),
    langPath: vendored(''),
    gzip: false,
  })
  return workerPromise
}

async function toRgba(dataUrl: string): Promise<RgbaImage> {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('could not get a 2d context for the image')

  context.drawImage(bitmap, 0, 0)
  bitmap.close()

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  return { width: pixels.width, height: pixels.height, data: pixels.data }
}

/** Preprocessed pixels back onto a canvas, which is what Tesseract accepts. */
function toCanvas(image: RgbaImage): OffscreenCanvas {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('could not get a 2d context for preprocessing')

  // Copy into a plain ArrayBuffer: ImageData refuses a SharedArrayBuffer view.
  context.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0,
  )
  return canvas
}

async function recognize(dataUrl: string): Promise<OcrResult> {
  const prepared = toCanvas(preprocess(await toRgba(dataUrl)))
  const blob = await prepared.convertToBlob({ type: 'image/png' })

  // §11 needs per-word confidence, and v7 only emits the block tree on request.
  const { data } = await (await engine()).recognize(blob, {}, { blocks: true, text: true })

  const words = (data.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.flatMap((line) =>
        line.words.map((word) => ({ text: word.text, confidence: word.confidence })),
      ),
    ),
  )

  return {
    text: data.text ?? '',
    words,
    // Tesseract's own mean can be absent; derive it rather than assume 0.
    meanConfidence: data.confidence ?? meanConfidenceOf(words),
  }
}

chrome.runtime.onMessage.addListener((message: OcrRecognizeRequest, _sender, sendResponse) => {
  // Popup and settings traffic shares this bus; ignore anything not ours.
  if (message?.target !== 'offscreen' || message.type !== 'ocr-recognize') return false

  recognize(message.dataUrl)
    .then((result) => sendResponse({ ok: true, result } satisfies OcrRecognizeResponse))
    .catch((error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies OcrRecognizeResponse),
    )

  return true
})
