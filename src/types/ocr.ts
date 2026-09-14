/** An image that could hold a coupon code, named before anything is fetched. */
export interface ImageCandidate {
  /**
   * Inline parts are served by Gmail and tell the sender nothing. Remote ones
   * are fetched from the sender's own host, which registers an open with them —
   * the disclosed cost of reading coupons that exist only as pixels.
   */
  source: 'inline' | 'remote'
  /** Inline only: present when Gmail kept the image in its attachment endpoint. */
  attachmentId: string | null
  /** Inline only: base64url bytes when Gmail put a small image in body.data. */
  data: string | null
  /** Remote only: the absolute URL the banner is served from. */
  url: string | null
  width: number | null
  height: number | null
  /** Declared area in px. Remote only: markup is the only size signal there. */
  pixelArea: number | null
  /** Gmail's declared part size, checked before the attachment is downloaded. */
  byteSize: number | null
  /** Inline only. A remote image is typed by the response that carries it. */
  mimeType: string | null
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
