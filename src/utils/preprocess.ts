import type { RgbaImage } from '../types/ocr.js'

/** Tesseract reads glyphs more reliably with more pixels per stroke. */
export const UPSCALE_FACTOR = 3

/** Limits decoded-image memory, which compressed file size cannot predict. */
export const MAX_OCR_PIXELS = 4_000_000

/** Requested scale, reduced as needed to stay within the pixel ceiling. */
export function scaleFactorFor(
  width: number,
  height: number,
  factor: number = UPSCALE_FACTOR,
): number {
  const pixels = width * height
  if (pixels <= 0) return factor
  return Math.min(factor, Math.sqrt(MAX_OCR_PIXELS / pixels))
}

/** Composites transparency onto white before thresholding. */
export function flattenOntoWhite(image: RgbaImage): RgbaImage {
  const out = new Uint8ClampedArray(image.data.length)

  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = (image.data[i + 3] ?? 255) / 255
    for (let channel = 0; channel < 3; channel += 1) {
      const value = image.data[i + channel] ?? 0
      out[i + channel] = value * alpha + 255 * (1 - alpha)
    }
    out[i + 3] = 255
  }

  return { width: image.width, height: image.height, data: out }
}

/** Deterministic nearest-neighbour resampling; a factor below one shrinks. */
export function upscale(image: RgbaImage, factor: number = UPSCALE_FACTOR): RgbaImage {
  if (factor === 1) return image

  const width = Math.max(1, Math.round(image.width * factor))
  const height = Math.max(1, Math.round(image.height * factor))
  const out = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(y / factor))
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / factor))
      const from = (sourceY * image.width + sourceX) * 4
      const to = (y * width + x) * 4
      out[to] = image.data[from] ?? 0
      out[to + 1] = image.data[from + 1] ?? 0
      out[to + 2] = image.data[from + 2] ?? 0
      out[to + 3] = image.data[from + 3] ?? 255
    }
  }

  return { width, height, data: out }
}

/** Rec. 601 luma, one byte per pixel. */
export function toGrayscale(image: RgbaImage): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(image.width * image.height)

  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const i = pixel * 4
    gray[pixel] =
      0.299 * (image.data[i] ?? 0) +
      0.587 * (image.data[i + 1] ?? 0) +
      0.114 * (image.data[i + 2] ?? 0)
  }

  return gray
}

/** Otsu threshold, maximising between-class variance. */
export function otsuThreshold(gray: Uint8ClampedArray): number {
  const histogram = new Array<number>(256).fill(0)
  for (const value of gray) histogram[value] = (histogram[value] ?? 0) + 1

  const total = gray.length
  if (total === 0) return 128

  let sum = 0
  for (let level = 0; level < 256; level += 1) sum += level * (histogram[level] ?? 0)

  let sumBackground = 0
  let weightBackground = 0
  let best = 0
  let bestVariance = -1

  for (let level = 0; level < 256; level += 1) {
    weightBackground += histogram[level] ?? 0
    if (weightBackground === 0) continue

    const weightForeground = total - weightBackground
    if (weightForeground === 0) break

    sumBackground += level * (histogram[level] ?? 0)
    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sum - sumBackground) / weightForeground
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2

    if (variance > bestVariance) {
      bestVariance = variance
      best = level
    }
  }

  return best
}

/** True for light text on a dark background. */
export function isLightOnDark(gray: Uint8ClampedArray, threshold: number): boolean {
  let dark = 0
  for (const value of gray) if (value <= threshold) dark += 1
  return dark > gray.length / 2
}

/** Black text on white, whichever way round the source was. */
export function binarize(
  gray: Uint8ClampedArray,
  threshold: number,
  invert: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gray.length)

  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const isDark = (gray[pixel] ?? 0) <= threshold
    const ink = invert ? !isDark : isDark
    out[pixel] = ink ? 0 : 255
  }

  return out
}

/** Back to RGBA so it can be written to a canvas for Tesseract. */
export function grayToRgba(gray: Uint8ClampedArray, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)

  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    const value = gray[pixel] ?? 255
    const i = pixel * 4
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
    data[i + 3] = 255
  }

  return { width, height, data }
}

/** The complete canvas-free OCR preprocessing pipeline. */
export function preprocess(image: RgbaImage, factor: number = UPSCALE_FACTOR): RgbaImage {
  const effective = scaleFactorFor(image.width, image.height, factor)

  // Shrink first when possible to lower peak memory without changing pixels.
  const scaled =
    effective < 1
      ? flattenOntoWhite(upscale(image, effective))
      : upscale(flattenOntoWhite(image), effective)

  const gray = toGrayscale(scaled)
  const threshold = otsuThreshold(gray)
  const binary = binarize(gray, threshold, isLightOnDark(gray, threshold))

  return grayToRgba(binary, scaled.width, scaled.height)
}
