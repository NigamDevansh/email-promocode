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
  otsuThreshold,
  preprocess,
  toGrayscale,
  upscale,
} from '../src/utils/preprocess.ts'

// ---------------------------------------------------------------- image choice

const img = (attrs: string): string => `<img ${attrs}>`

test('template furniture never reaches OCR', () => {
  const html = [
    img('src="https://cdn.x/logo.png" width="600" height="200"'),
    img('src="https://cdn.x/social-facebook.png" width="600" height="200"'),
    img('src="https://cdn.x/spacer.gif" width="600" height="200"'),
    img('src="https://cdn.x/tracking-pixel.gif" width="600" height="200"'),
    img('src="https://cdn.x/hero-banner.jpg" width="600" height="400"'),
  ].join('')

  assert.deepEqual(
    selectOcrImages(html, undefined).map((image) => image.ref),
    ['https://cdn.x/hero-banner.jpg'],
  )
})

test('an image declared too small to hold legible text is dropped', () => {
  const html = [
    img('src="https://cdn.x/tiny.png" width="80" height="20"'),
    img('src="https://cdn.x/short.png" width="600" height="40"'),
    img('src="https://cdn.x/banner.png" width="600" height="400"'),
  ].join('')

  assert.deepEqual(
    selectOcrImages(html, undefined).map((image) => image.ref),
    ['https://cdn.x/banner.png'],
  )
})

test('an undeclared size is kept, because templates often omit it', () => {
  const chosen = selectOcrImages(img('src="https://cdn.x/banner.png"'), undefined)
  assert.equal(chosen.length, 1)
  assert.equal(chosen[0]?.pixelArea, null)
})

test('only the largest one or two survive, biggest first', () => {
  const html = [
    img('src="https://cdn.x/a.png" width="300" height="300"'),
    img('src="https://cdn.x/b.png" width="900" height="600"'),
    img('src="https://cdn.x/c.png" width="600" height="400"'),
  ].join('')

  assert.deepEqual(
    selectOcrImages(html, undefined).map((image) => image.ref),
    ['https://cdn.x/b.png', 'https://cdn.x/c.png'],
  )
})

test('an inline part outranks a remote one: it tells the sender nothing', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/related',
    parts: [
      { mimeType: 'image/png', filename: 'banner.png', body: { attachmentId: 'att-1', size: 90_000 } },
    ],
  }
  const html = img('src="https://cdn.x/huge.png" width="1200" height="800"')

  const chosen = selectOcrImages(html, payload)
  assert.equal(chosen[0]?.source, 'inline')
  assert.equal(chosen[0]?.ref, 'att-1')
})

test('non-http sources are ignored', () => {
  const html = [
    img('src="cid:banner@mail" width="600" height="400"'),
    img('src="data:image/png;base64,AAAA" width="600" height="400"'),
  ].join('')

  assert.deepEqual(selectOcrImages(html, undefined), [])
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

test('inline size and remote size are never compared against each other', () => {
  // A small inline part still outranks a huge remote banner, because bytes and
  // pixels are not comparable and inline is preferred on privacy grounds.
  const payload: GmailPart = {
    mimeType: 'multipart/related',
    parts: [{ mimeType: 'image/png', body: { attachmentId: 'small', size: 7_000 } }],
  }
  const html = img('src="https://cdn.x/huge.png" width="1600" height="1200"')

  const chosen = selectOcrImages(html, payload)
  assert.deepEqual(
    chosen.map((image) => [image.source, image.byteSize, image.pixelArea]),
    [
      ['inline', 7_000, null],
      ['remote', null, 1_920_000],
    ],
  )
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
    selectOcrImages('', payload).map((image) => image.ref),
    ['large', 'small'],
  )
})
