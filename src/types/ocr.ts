/** An image that could hold a coupon code, named before fetching it. */
export interface ImageCandidate {
  source: 'inline' | 'remote'
  /** Inline only. */
  attachmentId: string | null
  /** Inline only: base64url bytes supplied directly by Gmail. */
  data: string | null
  /** Remote only. */
  url: string | null
  width: number | null
  height: number | null
  /** Remote-only dimensions declared in the markup. */
  pixelArea: number | null
  /** Gmail's declared inline-part size. */
  byteSize: number | null
  /** Inline only; a remote response supplies its own type. */
  mimeType: string | null
}

/** Raw pixels handed to preprocessing. */
export interface RgbaImage {
  width: number
  height: number
  /** `width * height * 4` RGBA bytes. */
  data: Uint8ClampedArray
}

/** One word and its Tesseract confidence. */
export interface OcrWord {
  text: string
  confidence: number
}

export interface OcrResult {
  text: string
  words: OcrWord[]
  meanConfidence: number
}

/** OCR contribution kept for local diagnostics. */
export interface OcrRun {
  imagesConsidered: number
  imagesRead: number
  imagesAccepted: number
  meanConfidence: number
  text: string
}

/** Service-worker to offscreen-document protocol; image bytes travel as a data URL. */
export interface OcrRecognizeRequest {
  target: 'offscreen'
  type: 'ocr-recognize'
  dataUrl: string
}

export type OcrRecognizeResponse =
  | { ok: true; result: OcrResult }
  | { ok: false; error: string }
