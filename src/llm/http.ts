import { LlmError, type LlmErrorKind } from '../types/llm.js'

/**
 * §6: honour `Retry-After` or the provider's reset time when present, rather
 * than assuming a tier. Providers disagree on the header, so all three shapes
 * are read here and normalised to milliseconds.
 */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const delays: number[] = []
  const retryAfter = headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) delays.push(Math.max(0, seconds * 1000))
    else {
      const date = Date.parse(retryAfter)
      if (!Number.isNaN(date)) delays.push(Math.max(0, date - now))
    }
  }

  // Anthropic publishes separate RFC 3339 resets for request and token buckets.
  for (const name of [
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-reset',
    'anthropic-ratelimit-input-tokens-reset',
    'anthropic-ratelimit-output-tokens-reset',
  ]) {
    const reset = headers.get(name)
    if (!reset) continue
    const date = Date.parse(reset)
    if (!Number.isNaN(date)) delays.push(Math.max(0, date - now))
  }

  // OpenAI uses durations such as "1s", "6m0s" or "250ms".
  for (const name of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const reset = headers.get(name)
    if (!reset) continue
    const parsed = parseDuration(reset)
    if (parsed !== undefined) delays.push(parsed)
  }

  return delays.length ? Math.max(...delays) : undefined
}

function parseDuration(value: string): number | undefined {
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g
  let total = 0
  let matched = false

  for (const match of value.matchAll(pattern)) {
    const amount = Number(match[1])
    const unit = match[2]
    if (!Number.isFinite(amount)) continue
    matched = true

    if (unit === 'ms') total += amount
    else if (unit === 's') total += amount * 1000
    else if (unit === 'm') total += amount * 60_000
    else if (unit === 'h') total += amount * 3_600_000
  }

  return matched ? total : undefined
}

function kindForStatus(status: number, body: string): LlmErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status === 408) return 'network'
  if (status === 404 || (status === 400 && /\b(model|unsupported parameter)\b/i.test(body))) {
    return 'model'
  }
  if (status >= 500) return 'server'
  return 'schema'
}

export async function errorForResponse(
  provider: string,
  response: Response,
  now: number = Date.now(),
): Promise<LlmError> {
  const body = await response.text().catch(() => '')
  const detail = body ? `: ${body.slice(0, 300)}` : ''

  return new LlmError(
    kindForStatus(response.status, body),
    `${provider} ${response.status}${detail}`,
    response.status,
    retryAfterMs(response.headers, now),
  )
}

/** A network failure surfaces as TypeError from fetch; that one is retryable. */
export function asLlmError(provider: string, error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof TypeError) {
    return new LlmError('network', `${provider} request failed: ${error.message}`)
  }
  return new LlmError('server', `${provider}: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * Structured-output mechanisms reduce malformed output but do not eliminate it,
 * so every provider's text goes through one guarded parse.
 */
export function parseJsonPayload(provider: string, text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new LlmError('schema', `${provider} returned an empty response body`)
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    throw new LlmError('schema', `${provider} returned text that is not JSON: ${trimmed.slice(0, 200)}`)
  }
}
