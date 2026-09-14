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

/** §6: interactive chat shares the limiter with backfill but jumps ahead of it. */
export type Priority = 'interactive' | 'background'

export interface QueueOptions {
  /** Minimum gap between requests. Throughput is not an MVP goal. */
  minSpacingMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/**
 * The queue surface consumers depend on. Declared here so types/ never has to
 * import a concrete class out of llm/.
 */
export interface TaskQueue {
  run<T>(priority: Priority, task: () => Promise<T>): Promise<T>
  pauseUntil(timestamp: number): void
  readonly pausedUntil: number
}

/** One coupon as the model reported it, after local validation. */
export interface ExtractedOffer {
  code: string
  normalizedCode: string
  discount: string | null
  currency: string | null
  minSpend: number | null
  maxDiscount: number | null
  expiry: string | null
  singleUse: boolean | null
  newUsersOnly: boolean
  appOnly: boolean
  categories: string[]
  conditions: string
}

export interface ExtractionRun {
  offers: ExtractedOffer[]
  usage: TokenUsage
}

export interface ExtractionDeps {
  adapter: ProviderAdapter
  settings: Settings
  queue: TaskQueue
  fetchImpl: typeof fetch
  priority?: Priority
}
