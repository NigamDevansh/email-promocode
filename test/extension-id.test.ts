import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { deriveExtensionId, readManifestKey } from '../scripts/extension-id.ts'

test('this build has a pinned key that yields a valid extension ID', () => {
  const id = deriveExtensionId(readManifestKey())
  assert.match(id, /^[a-p]{32}$/)
  assert.equal(id, 'bjbhbbododfldjjknhanpohghijlgpcc')
})

test('matches a known vector, pinning the digest and a-p mapping', () => {
  const key = Buffer.from('fixed public key bytes').toString('base64')
  assert.equal(deriveExtensionId(key), 'ghnemdlomnjnppbcbkjpbpkghmecopin')
})

test('different keys derive different IDs', () => {
  const a = Buffer.from('public key one').toString('base64')
  const b = Buffer.from('public key two').toString('base64')
  assert.notEqual(deriveExtensionId(a), deriveExtensionId(b))
})

test('the packaged extension can call Gmail and every supported LLM provider', () => {
  const manifest = JSON.parse(readFileSync('manifest.template.json', 'utf8')) as {
    host_permissions?: string[]
    permissions?: string[]
  }

  assert.deepEqual(manifest.host_permissions, [
    'https://gmail.googleapis.com/*',
    'https://api.anthropic.com/*',
    'https://api.openai.com/*',
    'https://generativelanguage.googleapis.com/*',
    // Coupons now live inside banners hosted on retailer CDNs that cannot be
    // enumerated ahead of time. If this line disappears, image-only coupons
    // stop being found at all.
    'https://*/*',
  ])
  assert.ok(manifest.permissions?.includes('alarms'), 'background sync needs the alarms permission')
  assert.ok(
    manifest.permissions?.includes('offscreen'),
    'Tesseract needs an offscreen document to spawn its workers',
  )
})

test('extension pages may instantiate WebAssembly', () => {
  const manifest = JSON.parse(readFileSync('manifest.template.json', 'utf8')) as {
    content_security_policy?: { extension_pages?: string }
  }

  // Without wasm-unsafe-eval the bundled Tesseract core cannot start at all.
  assert.match(
    manifest.content_security_policy?.extension_pages ?? '',
    /wasm-unsafe-eval/,
  )
})
