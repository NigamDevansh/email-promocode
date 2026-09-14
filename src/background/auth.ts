import type { AuthorizedFetchDeps } from '../types/auth.js'
import type { AuthState } from '../types/messaging.js'

/** Silent auth returned nothing: the user has simply not connected yet. */
export class NotConnectedError extends Error {
  constructor() {
    super('Not connected to Google')
    this.name = 'NotConnectedError'
  }
}

/**
 * A replacement token also failed. Terminal until the user clicks Connect.
 * Chrome cannot reliably tell seven-day Testing expiry from revoked access, so
 * the message deliberately does not claim which one happened.
 */
export class ReauthRequiredError extends Error {
  constructor() {
    super('Google access needs reconnecting')
    this.name = 'ReauthRequiredError'
  }
}

/**
 * Performs an authorized Gmail request, with the recovery path from §5:
 * on the first 401, drop the cached token and retry silently exactly once.
 * A second 401 is terminal — it never loops.
 */
export async function authorizedFetch(
  url: string,
  deps: AuthorizedFetchDeps,
  init: RequestInit = {},
): Promise<Response> {
  const { tokens, fetchImpl, onReauthRequired } = deps

  const token = await tokens.get(false)
  if (!token) throw new NotConnectedError()

  const first = await fetchImpl(url, withAuth(init, token))
  if (first.status !== 401) return first

  try {
    await tokens.remove(token)
  } catch {
    await onReauthRequired()
    throw new ReauthRequiredError()
  }

  const replacement = await tokens.get(false)
  if (!replacement) {
    await onReauthRequired()
    throw new ReauthRequiredError()
  }

  const second = await fetchImpl(url, withAuth(init, replacement))
  if (second.status === 401) {
    // Do not let a later interactive Connect reuse a token Gmail rejected.
    // Persist the terminal state even if Chrome fails to evict its cache entry.
    await tokens.remove(replacement).catch(() => undefined)
    await onReauthRequired()
    throw new ReauthRequiredError()
  }
  return second
}

function withAuth(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)

  return {
    ...init,
    headers,
  }
}

/** Maps a thrown auth error onto the state the popup should render. */
export function authStateForError(error: unknown): AuthState | null {
  if (error instanceof ReauthRequiredError) return 'reauth_required'
  if (error instanceof NotConnectedError) return 'disconnected'
  return null
}
