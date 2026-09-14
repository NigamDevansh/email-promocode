import type { Candidate } from '../types/extraction.js'
import type { ParsedMessage } from '../types/gmail.js'
import type { ProviderAdapter, Settings, TokenUsage } from '../types/llm.js'
import {
  buildExtractionPrompt,
  EXTRACTION_SCHEMA,
  EXTRACTION_SCHEMA_NAME,
  EXTRACTION_SYSTEM_PROMPT,
  validateExtraction,
  type ExtractedOffer,
} from './extraction.js'
import type { Priority, RequestQueue } from './queue.js'

/**
 * §3: output tokens are the expensive side at roughly a 1:5 ratio, so the cap
 * stays tight. A promotional email rarely carries more than a few codes.
 */
const MAX_OUTPUT_TOKENS = 800

export interface ExtractionRun {
  offers: ExtractedOffer[]
  usage: TokenUsage
}

export interface ExtractionDeps {
  adapter: ProviderAdapter
  settings: Settings
  queue: RequestQueue
  fetchImpl: typeof fetch
  priority?: Priority
}

/**
 * One structured extraction call for one message.
 *
 * The candidate list is both the prompt input and the acceptance set: §11's
 * "reject any returned string absent from the source" is enforced here, in
 * code, after the model has spoken.
 */
export async function extractMessageOffers(
  message: ParsedMessage,
  candidates: readonly Candidate[],
  deps: ExtractionDeps,
): Promise<ExtractionRun> {
  const allowed = new Map(candidates.map((candidate) => [candidate.normalized, candidate.code]))

  const result = await deps.queue.run(deps.priority ?? 'background', () =>
    deps.adapter.complete(
      {
        system: EXTRACTION_SYSTEM_PROMPT,
        user: buildExtractionPrompt(message, [...candidates]),
        schema: EXTRACTION_SCHEMA,
        schemaName: EXTRACTION_SCHEMA_NAME,
        maxTokens: MAX_OUTPUT_TOKENS,
      },
      {
        apiKey: deps.settings.apiKey,
        model: deps.settings.model,
        fetchImpl: deps.fetchImpl,
      },
    ),
  )

  return { offers: validateExtraction(result.json, allowed), usage: result.usage }
}
