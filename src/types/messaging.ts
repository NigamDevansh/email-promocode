import type { ProviderId, Settings } from './llm.js'
import type { OfferRecord } from './storage.js'

/** Auth states the popup can render. Mirrors §5 of the design doc. */
export type AuthState = 'disconnected' | 'connected' | 'reauth_required'

/** One Promotions message, reduced to what the popup preview displays. */
export interface MessageSummary {
  id: string
  threadId: string
  subject: string
  from: string
  /** Gmail internalDate, milliseconds since epoch. */
  date: number
}

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

export type PopupRequest =
  | { type: 'get-state' }
  | { type: 'connect' }
  | { type: 'list-messages' }
  | { type: 'sync' }
  | { type: 'list-offers' }
  | { type: 'get-settings' }
  | { type: 'save-settings'; settings: Partial<Settings> }
  | { type: 'clear-api-key' }

export type PopupResponse =
  | {
      ok: true
      authState: AuthState
      messages?: MessageSummary[]
      progress?: SyncProgress
      offers?: OfferRecord[]
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
  backfillDays: number
  enableOcr: boolean
  fetchRemoteImages: boolean
  hasApiKey: boolean
  apiKeyMasked: string
}
