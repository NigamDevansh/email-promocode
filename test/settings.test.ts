import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from '../src/utils/settings.ts'

test('saving the same provider with a blank key preserves its stored key', () => {
  const current = { ...DEFAULT_SETTINGS, apiKey: 'sk-ant-existing' }
  const next = mergeSettings(current, { model: 'another-model', apiKey: '' })

  assert.equal(next.apiKey, 'sk-ant-existing')
})

test('switching providers never reuses the previous provider key', () => {
  const current = { ...DEFAULT_SETTINGS, provider: 'anthropic' as const, apiKey: 'sk-ant-secret' }
  const next = mergeSettings(current, { provider: 'openai', apiKey: '' })

  assert.equal(next.provider, 'openai')
  assert.equal(next.apiKey, '')
  assert.equal(next.model, 'gpt-4o-mini')
})

test('switching providers accepts a replacement key supplied in the same save', () => {
  const current = { ...DEFAULT_SETTINGS, apiKey: 'sk-ant-secret' }
  const next = mergeSettings(current, { provider: 'gemini', apiKey: '  gemini-key  ' })

  assert.equal(next.apiKey, 'gemini-key')
  assert.equal(next.model, 'gemini-2.5-flash')
})

test('stored settings are clamped and invalid providers return to defaults', () => {
  const normalized = normalizeSettings({ provider: 'unknown', backfillDays: 9_999 })

  assert.equal(normalized.provider, DEFAULT_SETTINGS.provider)
  assert.equal(normalized.backfillDays, 365)
})
