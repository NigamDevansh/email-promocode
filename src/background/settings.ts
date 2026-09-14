import type { Settings } from '../types/llm.js'
import { mergeSettings, normalizeSettings } from '../utils/settings.js'

/**
 * §3: the LLM key is a runtime value in chrome.storage.local, never baked into
 * the bundle. Only the service worker reads it; the settings page sees a mask.
 */
const SETTINGS_KEY = 'settings'

export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  return normalizeSettings(stored[SETTINGS_KEY])
}

/**
 * An empty `apiKey` means "leave the stored key alone", so the settings form
 * can save a model change without ever handling the existing secret.
 */
export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await readSettings()
  const next = mergeSettings(current, patch)

  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}

export async function clearApiKey(): Promise<Settings> {
  const current = await readSettings()
  const next: Settings = { ...current, apiKey: '' }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}
