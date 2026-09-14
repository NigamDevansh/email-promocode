import type { AuthState } from '../types/messaging.js'
import { META_KEYS } from '../utils/storage.js'
import { indexedDbStore } from './idb.js'

/** Auth state shares the IndexedDB `meta` store with sync cursors. */
export async function readAuthState(): Promise<AuthState> {
  const value = await indexedDbStore.getMeta<AuthState>(META_KEYS.authState)
  return value === 'reauth_required' || value === 'connected' ? value : 'disconnected'
}

export async function writeAuthState(state: AuthState): Promise<void> {
  await indexedDbStore.setMeta(META_KEYS.authState, state)
}
