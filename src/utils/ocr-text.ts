import type { OcrResult, OcrWord } from '../types/ocr.js'

/*
 * §11 trust rule 3: "Refuse to guess on OCR. Low per-word confidence or
 * confusable glyphs (O/0, I/1, S/5, B/8) -> needs_review, and show 'couldn't
 * read confidently - open email' rather than a code."
 *
 * A wrong code that fails at checkout is worse than a missing one, so the bars
 * here are deliberately unkind: a word only survives if Tesseract was sure.
 */

/** Below this mean, the whole read is discarded rather than shown. */
export const OCR_CONFIDENCE_FLOOR = 60

/** A word Tesseract was less sure of than this is dropped. */
export const OCR_WORD_FLOOR = 70

/** Confusable glyphs must clear a higher bar, because O/0 is a silent failure. */
export const OCR_CONFUSABLE_FLOOR = 85

const CONFUSABLE = /[O0I1S5B8]/

/** §11: the glyph pairs that turn a working code into a broken one. */
export function hasConfusableGlyphs(text: string): boolean {
  return CONFUSABLE.test(text.toUpperCase())
}

function wordSurvives(word: OcrWord): boolean {
  const floor = hasConfusableGlyphs(word.text) ? OCR_CONFUSABLE_FLOOR : OCR_WORD_FLOOR
  return word.confidence >= floor
}

/**
 * The text worth handing to candidate detection, or an empty string when the
 * read was not confident enough to act on at all.
 */
export function usableOcrText(result: OcrResult): string {
  if (result.meanConfidence < OCR_CONFIDENCE_FLOOR) return ''

  return result.words
    .filter(wordSurvives)
    .map((word) => word.text.trim())
    .filter(Boolean)
    .join(' ')
}

/** Mean confidence across words, used when a provider does not report one. */
export function meanConfidenceOf(words: readonly OcrWord[]): number {
  if (words.length === 0) return 0
  return words.reduce((total, word) => total + word.confidence, 0) / words.length
}
