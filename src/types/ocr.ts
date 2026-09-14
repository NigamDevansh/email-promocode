/** An image worth spending OCR on, chosen before anything is fetched or decoded. */
export interface ImageCandidate {
  /**
   * Inline parts are served by Google and register nothing with the sender.
   * Remote parts are fetched from the retailer CDN and do register an open.
   */
  source: 'inline' | 'remote'
  /** attachmentId for an inline part, absolute URL for a remote one. */
  ref: string
  width: number | null
  height: number | null
  /** Declared area in px. Remote only: markup is the only size signal there. */
  pixelArea: number | null
  /** Part size in bytes. Inline only: Gmail reports size, never dimensions. */
  byteSize: number | null
  alt: string
}

/** Raw pixels handed to preprocessing. */
export interface RgbaImage {
  width: number
  height: number
  /** Length is width * height * 4. */
  data: Uint8ClampedArray
}

/** One word Tesseract read, with the confidence it reported. */
export interface OcrWord {
  text: string
  /** 0-100, as Tesseract reports it. */
  confidence: number
}

export interface OcrResult {
  text: string
  words: OcrWord[]
  /** Mean word confidence, 0-100. */
  meanConfidence: number
}

/** What OCR contributed to one message, kept for local diagnostics. */
export interface OcrRun {
  /** Images chosen as worth reading. */
  imagesConsidered: number
  /** Images that actually reached the engine, whatever came back. */
  imagesRead: number
  /** Of those, how many produced text confident enough to use. */
  imagesAccepted: number
  meanConfidence: number
  /** Text recovered from the images, concatenated. */
  text: string
}

/*
 * Service worker <-> offscreen document protocol.
 *
 * Chrome messaging serialises as JSON, so pixels cannot cross as an
 * ArrayBuffer. The image travels as a data URL that the offscreen document
 * decodes; every network fetch stays in the service worker, where the
 * credential and referrer policy is applied in one place.
 */
export interface OcrRecognizeRequest {
  /** Discriminator: the offscreen document ignores anything else on the bus. */
  target: 'offscreen'
  type: 'ocr-recognize'
  dataUrl: string
}

export type OcrRecognizeResponse =
  | { ok: true; result: OcrResult }
  | { ok: false; error: string }
