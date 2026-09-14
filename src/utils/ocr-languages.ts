/** English always ships because coupon codes are ASCII. */
export const BASE_OCR_LANGUAGE = 'eng'

/** Restrict language codes because they become URL and filename segments. */
const LANGUAGE_CODE = /^[a-z]{2,4}(_[a-z]{2,8})?$/

export class OcrLanguageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OcrLanguageError'
  }
}

/** Parses `OCR_LANGUAGES` into the packs to download and load. */
export function parseOcrLanguages(raw: string | undefined): string[] {
  const requested = (raw ?? '')
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean)

  const invalid = requested.filter((code) => !LANGUAGE_CODE.test(code))
  if (invalid.length > 0) {
    throw new OcrLanguageError(
      `OCR_LANGUAGES contains invalid Tesseract codes: ${invalid.join(', ')}.\n` +
        'Use lowercase codes such as eng, hin, chi_sim. See ' +
        'https://github.com/tesseract-ocr/tessdata_fast for the full list.',
    )
  }

  return [...new Set([BASE_OCR_LANGUAGE, ...requested])]
}

export function toTesseractLanguage(languages: readonly string[]): string {
  return languages.join('+')
}
