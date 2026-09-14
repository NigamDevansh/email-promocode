import { LlmError } from '../types/llm.js'
import { GmailApiError } from './gmail.js'

export const DEFAULT_SYNC_RETRY_MS = 30_000
export const MAX_SYNC_RETRY_MS = 15 * 60_000

function isGmailRateLimit(error: GmailApiError): boolean {
  const reason = error.reason?.replaceAll('_', '').replaceAll('-', '').toLowerCase()
  return reason === 'ratelimitexceeded' || reason === 'userratelimitexceeded'
}

/** Returns a retry delay for failures that should not pause syncing permanently. */
export function syncRetryDelay(error: unknown, attempt: number = 1): number | null {
  const exponentialDelay = Math.min(
    DEFAULT_SYNC_RETRY_MS * 2 ** Math.max(0, attempt - 1),
    MAX_SYNC_RETRY_MS,
  )

  if (error instanceof LlmError) {
    if (!error.retryable) return null
    return Math.max(exponentialDelay, error.retryAfterMs ?? 0)
  }

  if (
    error instanceof GmailApiError &&
    (error.status === 408 ||
      error.status === 429 ||
      error.status >= 500 ||
      (error.status === 403 && isGmailRateLimit(error)))
  ) {
    return exponentialDelay
  }

  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
    return exponentialDelay
  }

  return null
}
