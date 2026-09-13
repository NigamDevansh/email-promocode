import type { AuthState } from '../types/messaging.js'

/*
 * Phase 1 keeps auth state in chrome.storage.local. Phase 2 introduces the
 * IndexedDB `meta` store described in §9 and this moves there alongside
 * historyId and the backfill checkpoint.
 */
const AUTH_STATE_KEY = 'authState'

export async function readAuthState(): Promise<AuthState> {
  const stored = await chrome.storage.local.get(AUTH_STATE_KEY)
  const value = stored[AUTH_STATE_KEY]
  return value === 'reauth_required' || value === 'connected' ? value : 'disconnected'
}

export async function writeAuthState(state: AuthState): Promise<void> {
  await chrome.storage.local.set({ [AUTH_STATE_KEY]: state })
}
