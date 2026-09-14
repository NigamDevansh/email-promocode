import type { ProviderId, Settings } from './llm.js'
import type { ChatTurnRecord } from './chat.js'
import type { OfferRecord } from './storage.js'

/** Auth states the popup can render. Mirrors §5 of the design doc. */
export type AuthState = 'disconnected' | 'connected' | 'reauth_required'

/** One backfill slice's outcome, surfaced to the popup. */
export interface SyncProgress {
  processed: number
  skipped: number
  withCandidates: number
  totalProcessed: number
  remaining: boolean
  nextAttemptAt?: number
  error?: string
}

export interface SyncStatus {
  state: 'loading' | 'waiting' | 'ready' | 'blocked'
  totalProcessed: number
  nextAttemptAt?: number
  message?: string
}

export type PopupRequest =
  | { type: 'get-state' }
  | { type: 'connect' }
  | { type: 'get-sync-status' }
  | { type: 'get-chat' }
  | { type: 'send-chat'; question: string }
  | { type: 'get-settings' }
  | { type: 'save-settings'; settings: Partial<Settings> }
  | { type: 'clear-api-key' }

export type PopupResponse =
  | {
      ok: true
      authState: AuthState
      progress?: SyncProgress
      syncStatus?: SyncStatus
      offers?: OfferRecord[]
      chatTurns?: ChatTurnRecord[]
      settings?: SettingsView
    }
  | { ok: false; authState: AuthState; error: string }

/**
 * What the settings page is allowed to see. The raw key never leaves the
 * service worker once it has been stored.
 */
export interface SettingsView {
  provider: ProviderId
  model: string
  hasApiKey: boolean
  apiKeyMasked: string
}
