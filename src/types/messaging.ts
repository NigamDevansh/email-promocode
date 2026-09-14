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

export type PopupResponse =
  | {
      ok: true
      authState: AuthState
      messages?: MessageSummary[]
      progress?: SyncProgress
      offers?: OfferRecord[]
    }
  | { ok: false; authState: AuthState; error: string }
