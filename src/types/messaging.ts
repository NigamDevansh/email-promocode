/** Auth states the popup can render. Mirrors §5 of the design doc. */
export type AuthState = 'disconnected' | 'connected' | 'reauth_required'

/** One Promotions message, reduced to what phase 1 displays. */
export interface MessageSummary {
  id: string
  threadId: string
  subject: string
  from: string
  /** Gmail internalDate, milliseconds since epoch. */
  date: number
}

export type PopupRequest =
  | { type: 'get-state' }
  | { type: 'connect' }
  | { type: 'list-messages' }

export type PopupResponse =
  | { ok: true; authState: AuthState; messages?: MessageSummary[] }
  | { ok: false; authState: AuthState; error: string }
