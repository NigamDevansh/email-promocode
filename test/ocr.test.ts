import assert from 'node:assert/strict'
import test from 'node:test'
import type { GmailPart } from '../src/types/gmail.ts'
import type { OcrResult, RgbaImage } from '../src/types/ocr.ts'
import { isWorthReading, selectOcrImages } from '../src/utils/images.ts'
import {
  hasConfusableGlyphs,
  meanConfidenceOf,
  usableOcrText,
} from '../src/utils/ocr-text.ts'
import {
  binarize,
  flattenOntoWhite,
  isLightOnDark,
  MAX_OCR_PIXELS,
  otsuThreshold,
  preprocess,
  scaleFactorFor,
  toGrayscale,
  upscale,
} from '../src/utils/preprocess.ts'

// ---------------------------------------------------------------- image choice

test('template furniture never reaches OCR', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/related',
    parts: [
      { mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'logo', size: 90_000 } },
      { mimeType: 'image/png', filename: 'hero-banner.png', body: { attachmentId: 'hero', size: 90_000 } },
    ],
  }
  assert.deepEqual(selectOcrImages(payload).map((image) => image.attachmentId), ['hero'])
})

test('only the largest one or two inline images survive, biggest first', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/related',
    parts: [
      { mimeType: 'image/png', body: { attachmentId: 'small', size: 9_000 } },
      { mimeType: 'image/png', body: { attachmentId: 'large', size: 400_000 } },
      { mimeType: 'image/png', body: { attachmentId: 'medium', size: 90_000 } },
    ],
  }
  assert.deepEqual(
    selectOcrImages(payload).map((image) => image.attachmentId),
    ['large', 'medium'],
  )
})

test('a fetched image too small in bytes is not worth reading', () => {
  assert.equal(isWorthReading(900), false)
  assert.equal(isWorthReading(60_000), true)
})

// ------------------------------------------------------------- preprocessing

function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0]
    data[i + 1] = rgba[1]
    data[i + 2] = rgba[2]
    data[i + 3] = rgba[3]
  }
  return { width, height, data }
}

test('transparency flattens onto white, not onto black', () => {
  // Fully transparent black is the classic PNG trap: left alone it reads as ink.
  const flattened = flattenOntoWhite(solid(2, 2, [0, 0, 0, 0]))
  assert.equal(flattened.data[0], 255)
  assert.equal(flattened.data[3], 255, 'alpha is now opaque')
})

test('half-transparent ink lands halfway to white', () => {
  const flattened = flattenOntoWhite(solid(1, 1, [0, 0, 0, 128]))
  assert.ok(Math.abs((flattened.data[0] ?? 0) - 127) <= 2)
})

test('upscaling multiplies the dimensions and replicates pixels', () => {
  const scaled = upscale(solid(2, 2, [10, 20, 30, 255]), 3)
  assert.deepEqual([scaled.width, scaled.height], [6, 6])
  assert.equal(scaled.data.length, 6 * 6 * 4)
  assert.deepEqual([...(scaled.data.slice(0, 4) ?? [])], [10, 20, 30, 255])
})

test('otsu finds a threshold that separates the two modes', () => {
  const gray = new Uint8ClampedArray([20, 22, 18, 25, 230, 235, 228, 240])
  const threshold = otsuThreshold(gray)

  // The property that matters is the split, not the number: binarize treats
  // `<= threshold` as ink, so the dark mode must land entirely on one side.
  assert.deepEqual(
    [...binarize(gray, threshold, false)],
    [0, 0, 0, 0, 255, 255, 255, 255],
  )
})

test('polarity detection spots light text on a dark banner', () => {
  // Mostly dark pixels means the background is dark.
  const darkBackground = new Uint8ClampedArray([10, 10, 10, 10, 10, 10, 250, 250])
  assert.equal(isLightOnDark(darkBackground, otsuThreshold(darkBackground)), true)

  const lightBackground = new Uint8ClampedArray([250, 250, 250, 250, 250, 250, 10, 10])
  assert.equal(isLightOnDark(lightBackground, otsuThreshold(lightBackground)), false)
})

test('binarising inverts light-on-dark so ink ends up black either way', () => {
  const darkText = new Uint8ClampedArray([10, 250])
  assert.deepEqual([...binarize(darkText, 128, false)], [0, 255], 'dark pixel becomes ink')

  const lightText = new Uint8ClampedArray([10, 250])
  assert.deepEqual([...binarize(lightText, 128, true)], [255, 0], 'inverted: light pixel is ink')
})

test('the pipeline turns light-on-dark input into dark-on-light output', () => {
  // A 4x1 strip: three dark background pixels and one light "glyph".
  const data = new Uint8ClampedArray([
    10, 10, 10, 255, 10, 10, 10, 255, 10, 10, 10, 255, 245, 245, 245, 255,
  ])
  const out = preprocess({ width: 4, height: 1, data }, 1)
  const gray = toGrayscale(out)

  assert.equal(gray[3], 0, 'the glyph pixel is now black ink')
  assert.equal(gray[0], 255, 'the background is now white')
})

test('preprocessing is deterministic for the same input', () => {
  const image = solid(4, 4, [120, 130, 140, 255])
  assert.deepEqual([...preprocess(image, 2).data], [...preprocess(image, 2).data])
})

// --------------------------------------------------------- refusing to guess

const words = (entries: [string, number][]): OcrResult => ({
  text: entries.map(([text]) => text).join(' '),
  words: entries.map(([text, confidence]) => ({ text, confidence })),
  meanConfidence: meanConfidenceOf(entries.map(([text, confidence]) => ({ text, confidence }))),
})

test('a read the engine was unsure of is discarded entirely', () => {
  assert.equal(usableOcrText(words([['MONSOON40', 40], ['USE', 45]])), '')
})

test('a low-confidence word is dropped from an otherwise good read', () => {
  const text = usableOcrText(words([['USE', 95], ['CODE', 96], ['XZQW', 50]]))
  assert.equal(text, 'USE CODE')
})

test('confusable glyphs must clear a higher bar than ordinary words', () => {
  // O/0 at 80 is exactly the silent failure section 11 warns about.
  assert.equal(hasConfusableGlyphs('MONSOON40'), true)
  assert.equal(hasConfusableGlyphs('RAKE'), false)

  assert.equal(usableOcrText(words([['MONSOON40', 80], ['RAKE', 80]])), 'RAKE')
  assert.match(usableOcrText(words([['MONSOON40', 92], ['RAKE', 92]])), /MONSOON40/)
})

test('a confident read passes through intact', () => {
  assert.equal(usableOcrText(words([['USE', 95], ['CODE', 94], ['RAKE25', 93]])), 'USE CODE RAKE25')
})

test('mean confidence of nothing is zero, not NaN', () => {
  assert.equal(meanConfidenceOf([]), 0)
})

test('inline parts rank against each other by bytes', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/related',
    parts: [
      { mimeType: 'image/png', body: { attachmentId: 'small', size: 9_000 } },
      { mimeType: 'image/png', body: { attachmentId: 'large', size: 400_000 } },
    ],
  }

  assert.deepEqual(
    selectOcrImages(payload).map((image) => image.attachmentId),
    ['large', 'small'],
  )
})

// ------------------------------------------------------------- the pixel ceiling

test('a banner small enough to grow is still tripled', () => {
  assert.equal(scaleFactorFor(600, 400, 3), 3)
})

test('an image that would blow past the ceiling is scaled down to meet it', () => {
  // An 8MB JPEG can decode to twelve megapixels; tripling it allocates
  // hundreds of megabytes of intermediates inside the offscreen document.
  const factor = scaleFactorFor(4000, 3000, 3)

  assert.ok(factor < 1, 'shrunk rather than grown')
  assert.ok(4000 * factor * (3000 * factor) <= MAX_OCR_PIXELS + 1)
})

test('the ceiling holds whatever the source dimensions are', () => {
  for (const [width, height] of [
    [600, 400],
    [2400, 1800],
    [4000, 3000],
    [12_000, 200],
  ] as const) {
    const factor = scaleFactorFor(width, height, 3)
    const pixels = Math.round(width * factor) * Math.round(height * factor)
    assert.ok(pixels <= MAX_OCR_PIXELS * 1.01, `${width}x${height} stays under the ceiling`)
  }
})

test('shrinking preserves the picture rather than emptying it', () => {
  const image = solid(4, 4, [10, 20, 30, 255])
  const shrunk = upscale(image, 0.5)

  assert.deepEqual([shrunk.width, shrunk.height], [2, 2])
  assert.deepEqual([...(shrunk.data.slice(0, 4) ?? [])], [10, 20, 30, 255])
})

test('an image too small to survive a shrink keeps at least one pixel', () => {
  const shrunk = upscale(solid(2, 2, [0, 0, 0, 255]), 0.1)
  assert.deepEqual([shrunk.width, shrunk.height], [1, 1])
})

test('an oversized banner still comes out of the pipeline as dark ink on white', () => {
  // Wide enough to be shrunk: the polarity work must survive the resample.
  const width = 3000
  const height = 2000
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    // A dark background with a light stripe down the left edge.
    const value = pixel % width < width / 8 ? 245 : 10
    const i = pixel * 4
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
    data[i + 3] = 255
  }

  const out = preprocess({ width, height, data })
  const gray = toGrayscale(out)

  assert.ok(out.width * out.height <= MAX_OCR_PIXELS, 'the ceiling was respected')
  assert.equal(gray[0], 0, 'the light stripe is ink')
  assert.equal(gray[out.width - 1], 255, 'the dark background is paper')
})
