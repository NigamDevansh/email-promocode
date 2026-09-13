import assert from 'node:assert/strict'
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
