import type { ProviderId, Settings } from '../types/llm.js'

export const PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'gemini']

/**
 * §3: provider base URLs are fixed in code. Custom and local endpoints are
 * deliberately out of scope for this version.
 */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
}

/** Cheap, structured-output-capable defaults. Extraction does not need a frontier model. */
export const DEFAULT_MODELS: Readonly<Record<ProviderId, string>> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  apiKey: '',
  model: DEFAULT_MODELS.anthropic,
  backfillDays: 45,
}

function isProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
}

/**
 * Coerces whatever is on disk into usable settings. Storage is editable by hand
 * and survives version changes, so nothing here may assume a valid shape.
 */
export function normalizeSettings(raw: unknown): Settings {
  const record = (raw ?? {}) as Record<string, unknown>
  const provider = isProvider(record['provider']) ? record['provider'] : DEFAULT_SETTINGS.provider

  const model = typeof record['model'] === 'string' ? record['model'].trim() : ''
  const days = Number(record['backfillDays'])

  return {
    provider,
    apiKey: typeof record['apiKey'] === 'string' ? record['apiKey'].trim() : '',
    model: model || DEFAULT_MODELS[provider],
    // §6: the deeper scan is opt-in; keep the window inside sane bounds.
    backfillDays: Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 1), 365) : 45,
  }
}

/** Preserves a key only while saving settings for the same provider. */
export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  const providerChanged = patch.provider !== undefined && patch.provider !== current.provider
  const suppliedKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : ''
  const apiKey = suppliedKey || (providerChanged ? '' : current.apiKey)
  const suppliedModel = typeof patch.model === 'string' ? patch.model.trim() : ''
  const model = providerChanged
    ? suppliedModel || DEFAULT_MODELS[patch.provider ?? current.provider]
    : patch.model

  return normalizeSettings({ ...current, ...patch, apiKey, ...(model !== undefined ? { model } : {}) })
}

/** True when the LLM layer has everything it needs to make a request. */
export function isConfigured(settings: Settings): boolean {
  return settings.apiKey.length > 0 && settings.model.length > 0
}

/** Never render a stored key in full; the settings form shows this instead. */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return ''
  if (apiKey.length <= 8) return '••••'
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`
}
