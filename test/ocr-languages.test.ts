import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BASE_OCR_LANGUAGE,
  OcrLanguageError,
  parseOcrLanguages,
  toTesseractLanguage,
} from '../src/utils/ocr-languages.ts'

test('an unset or empty list builds English only', () => {
  assert.deepEqual(parseOcrLanguages(undefined), ['eng'])
  assert.deepEqual(parseOcrLanguages(''), ['eng'])
  assert.deepEqual(parseOcrLanguages('   ,  ,'), ['eng'])
})

test('extra languages are added alongside English', () => {
  assert.deepEqual(parseOcrLanguages('hin,fra'), ['eng', 'hin', 'fra'])
})

test('English survives even when the list leaves it out', () => {
  assert.deepEqual(parseOcrLanguages('hin'), [BASE_OCR_LANGUAGE, 'hin'])
})

test('whitespace, case and duplicates are normalised away', () => {
  assert.deepEqual(parseOcrLanguages(' HIN , hin,  Fra '), ['eng', 'hin', 'fra'])
})

test('script-suffixed codes are accepted', () => {
  assert.deepEqual(parseOcrLanguages('chi_sim,srp_latn'), ['eng', 'chi_sim', 'srp_latn'])
})

test('anything that could escape a path or URL is rejected', () => {
  for (const bad of ['../../etc/passwd', 'eng/../x', 'eng.traineddata', 'e n g', 'ENG!', 'https://x']) {
    assert.throws(() => parseOcrLanguages(bad), OcrLanguageError, `should reject ${bad}`)
  }
})

test('a rejection names the offending codes and where to find valid ones', () => {
  assert.throws(
    () => parseOcrLanguages('hin,not-a-code'),
    (error: OcrLanguageError) => {
      assert.match(error.message, /not-a-code/)
      assert.doesNotMatch(error.message, /\bhin\b.*invalid/)
      assert.match(error.message, /tessdata_fast/)
      return true
    },
  )
})

test('Tesseract receives the packs joined the way it expects', () => {
  assert.equal(toTesseractLanguage(['eng']), 'eng')
  assert.equal(toTesseractLanguage(['eng', 'hin']), 'eng+hin')
})
