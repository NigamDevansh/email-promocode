import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * §7: "Tesseract core and eng.traineddata must be bundled — MV3 blocks remotely
 * hosted code at runtime, not just by policy."
 *
 * The engine therefore has to be on disk inside the extension. It is copied
 * into public/ (which Vite already mirrors into dist/) rather than committed,
 * so the repository stays free of several megabytes of binaries while the built
 * extension still ships everything it needs.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(root, 'public/vendor/tesseract')

/** LSTM-only SIMD build: the smallest core that still reads banner text well. */
const FROM_NODE_MODULES = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
] as const

/*
 * tessdata_fast: ~4MB instead of ~15MB, and accurate enough for banner text.
 *
 * Pinned to a commit rather than `main`, and checked against a known digest.
 * A moving branch would make the build unreproducible and would let the
 * language data change under the extension without anyone noticing — this is
 * a binary the OCR stage trusts completely. The npm copies above need no such
 * check: the lockfile already pins them by integrity hash.
 */
const TRAINEDDATA_REVISION = '87416418657359cb625c412a48b6e1d6d41c29bd'
const TRAINEDDATA_SHA256 = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
const TRAINEDDATA_URL = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TRAINEDDATA_REVISION}/eng.traineddata`

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function verify(bytes: Buffer, source: string): void {
  const digest = sha256(bytes)
  if (digest === TRAINEDDATA_SHA256) return

  throw new Error(
    `eng.traineddata from ${source} does not match the pinned digest.\n` +
      `  expected ${TRAINEDDATA_SHA256}\n` +
      `  actual   ${digest}`,
  )
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

  const trainedData = resolve(target, 'eng.traineddata')

  if (existsSync(trainedData)) {
    // Re-verified rather than trusted: a cached file can be truncated or stale.
    verify(readFileSync(trainedData), 'the local cache')
    console.log(`kept    eng.traineddata (${(statSync(trainedData).size / 1e6).toFixed(1)} MB, verified)`)
    return
  }

  console.log(`fetching eng.traineddata @ ${TRAINEDDATA_REVISION.slice(0, 7)}…`)
  const response = await fetch(TRAINEDDATA_URL)
  if (!response.ok) {
    throw new Error(`Could not download eng.traineddata: HTTP ${response.status}`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  verify(bytes, TRAINEDDATA_URL)
  writeFileSync(trainedData, bytes)
  console.log(`fetched eng.traineddata (${(bytes.length / 1e6).toFixed(1)} MB, verified)`)
}

await main()
