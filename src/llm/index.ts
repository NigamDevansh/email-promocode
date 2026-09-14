import type { ProviderAdapter, ProviderId } from '../types/llm.js'
import { anthropicAdapter } from './anthropic.js'
import { geminiAdapter } from './gemini.js'
import { openaiAdapter } from './openai.js'

/**
 * The only place a provider is chosen. Everything downstream talks to
 * ProviderAdapter, so no provider conditionals exist elsewhere in the codebase.
 */
const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
}

export function adapterFor(provider: ProviderId): ProviderAdapter {
  return ADAPTERS[provider]
}

export { anthropicAdapter, geminiAdapter, openaiAdapter }
