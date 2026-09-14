import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { parseOcrLanguages } from '../src/utils/ocr-languages.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(root, 'public/vendor/tesseract')
const lockPath = resolve(root, 'ocr-languages.lock.json')

/** LSTM-only SIMD core, declared directly because this script needs a stable path. */
const FROM_NODE_MODULES = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
] as const

interface LanguageLock {
  revision: string
  languages: Record<string, string>
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as LanguageLock

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const urlFor = (language: string): string =>
  `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${lock.revision}/${language}.traineddata`

function modeFromArgs(): string {
  const index = process.argv.indexOf('--mode')
  if (index === -1) return 'production'

  const mode = process.argv[index + 1]
  if (!mode || mode.startsWith('-')) throw new Error('Expected a value after --mode.')
  return mode
}

/** Uses Vite's parser so vendored packs exactly match the worker configuration. */
function languagesFromEnv(): string[] {
  return parseOcrLanguages(loadEnv(modeFromArgs(), root, '').OCR_LANGUAGES)
}

function verify(language: string, bytes: Buffer): 'verified' | 'recorded' {
  const digest = sha256(bytes)
  const known = lock.languages[language]

  if (!known) {
    lock.languages[language] = digest
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
    return 'recorded'
  }

  if (digest !== known) {
    throw new Error(
      `${language}.traineddata does not match the pinned digest.\n` +
        `  expected ${known}\n` +
        `  actual   ${digest}\n` +
        'Delete the cached file and retry, or update ocr-languages.lock.json deliberately.',
    )
  }

  return 'verified'
}

async function vendorLanguage(language: string): Promise<number> {
  const file = resolve(target, `${language}.traineddata`)

  if (existsSync(file)) {
    const state = verify(language, readFileSync(file))
    const size = statSync(file).size
    console.log(`kept    ${language}.traineddata (${(size / 1e6).toFixed(1)} MB, ${state})`)
    return size
  }

  console.log(`fetching ${language}.traineddata @ ${lock.revision.slice(0, 7)}…`)
  const response = await fetch(urlFor(language))
  if (!response.ok) {
    throw new Error(
      `Could not download ${language}.traineddata: HTTP ${response.status}.\n` +
        `Check that "${language}" exists in tessdata_fast at ${lock.revision.slice(0, 7)}.`,
    )
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const state = verify(language, bytes)
  writeFileSync(file, bytes)
  console.log(`fetched ${language}.traineddata (${(bytes.length / 1e6).toFixed(1)} MB, ${state})`)
  if (state === 'recorded') {
    console.log('        new digest written to ocr-languages.lock.json — commit it')
  }

  return bytes.length
}

async function main(): Promise<void> {
  mkdirSync(target, { recursive: true })

  for (const [from, to] of FROM_NODE_MODULES) {
    const source = resolve(root, 'node_modules', from)
    if (!existsSync(source)) {
      throw new Error(`Missing ${from}. Run npm install first.`)
    }
    copyFileSync(source, resolve(target, to))
    console.log(`copied  ${to} (${(statSync(source).size / 1e6).toFixed(1)} MB)`)
  }

  const languages = languagesFromEnv()
  let languageBytes = 0
  for (const language of languages) languageBytes += await vendorLanguage(language)

  for (const file of readdirSync(target)) {
    if (!file.endsWith('.traineddata')) continue
    if (languages.includes(file.replace('.traineddata', ''))) continue

    rmSync(resolve(target, file))
    console.log(`removed ${file} (no longer in OCR_LANGUAGES)`)
  }

  console.log(
    `\nOCR languages: ${languages.join(', ')} (${(languageBytes / 1e6).toFixed(1)} MB of language data)`,
  )
}

await main()
