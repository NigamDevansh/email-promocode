export type ProviderId = 'anthropic' | 'openai' | 'gemini'

/** Runtime settings, stored in chrome.storage.local and never in the bundle. */
export interface Settings {
  provider: ProviderId
  apiKey: string
  model: string
  backfillDays: number
  enableOcr: boolean
  fetchRemoteImages: boolean
}

/** A JSON Schema subset, enough for the structured-output contracts. */
export interface JsonSchema {
  /** An array expresses a nullable type, e.g. ['string', 'null']. */
  type: string | string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
  enum?: string[]
  description?: string
  additionalProperties?: boolean
  [key: string]: unknown
}

export interface CompletionRequest {
  system: string
  user: string
  /** The provider's own structured-output mechanism is driven by this. */
  schema: JsonSchema
  schemaName: string
  maxTokens: number
}

/** Normalised so local diagnostics read identically across providers. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface CompletionResult {
  json: unknown
  usage: TokenUsage
}

export interface ProviderContext {
  apiKey: string
  model: string
  fetchImpl: typeof fetch
}

export interface ProviderAdapter {
  readonly id: ProviderId
  complete(request: CompletionRequest, context: ProviderContext): Promise<CompletionResult>
}

/**
 * §6: authentication, permission, schema and invalid-model failures are never
 * retried automatically. Only `rate-limit`, `server` and `network` are transient.
 */
export type LlmErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'schema'
  | 'refusal'
  | 'model'

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
    /** Parsed from Retry-After or a provider reset header, when present. */
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'LlmError'
  }

  get retryable(): boolean {
    return this.kind === 'rate-limit' || this.kind === 'server' || this.kind === 'network'
  }
}
