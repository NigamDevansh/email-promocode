import type { AuthorizedFetchDeps } from '../types/auth.js'
import type { AuthState, PopupRequest, PopupResponse } from '../types/messaging.js'
import {
  authStateForError,
  ReauthRequiredError,
} from './auth.js'
import { chromeTokens } from './chrome-tokens.js'
import { listPromotionSummaries } from './gmail.js'
import { readAuthState, writeAuthState } from './state.js'

/** Phase 1 shows a single page of recent subjects. Phase 2 owns the real backfill. */
const POPUP_MESSAGE_LIMIT = 25

const deps: AuthorizedFetchDeps = {
  tokens: chromeTokens,
  fetchImpl: (...args) => fetch(...args),
  onReauthRequired: () => writeAuthState('reauth_required'),
}

/**
 * Silent probe on popup open. A stored `reauth_required` is terminal and is not
 * re-probed: only the Connect gesture leaves that state.
 */
async function currentAuthState(): Promise<AuthState> {
  const stored = await readAuthState()
  if (stored === 'reauth_required') return stored

  const token = await chromeTokens.get(false)
  const state: AuthState = token ? 'connected' : 'disconnected'
  if (state !== stored) await writeAuthState(state)
  return state
}

/** Interactive auth runs only from the Connect gesture in the popup. */
async function connect(): Promise<AuthState> {
  const token = await chromeTokens.get(true)
  const state: AuthState = token ? 'connected' : 'disconnected'
  await writeAuthState(state)
  return state
}

async function handle(request: PopupRequest): Promise<PopupResponse> {
  switch (request.type) {
    case 'get-state':
      return { ok: true, authState: await currentAuthState() }

    case 'connect':
      return { ok: true, authState: await connect() }

    case 'list-messages': {
      if ((await readAuthState()) === 'reauth_required') {
        throw new ReauthRequiredError()
      }
      const messages = await listPromotionSummaries(deps, POPUP_MESSAGE_LIMIT)
      await writeAuthState('connected')
      return { ok: true, authState: 'connected', messages }
    }
  }
}

// Registered synchronously at module scope so the worker can be woken by it.
chrome.runtime.onMessage.addListener((request: PopupRequest, _sender, sendResponse) => {
  handle(request)
    .then(sendResponse)
    .catch(async (error: unknown) => {
      const mapped = authStateForError(error)
      sendResponse({
        ok: false,
        authState: mapped ?? (await readAuthState()),
        error: error instanceof Error ? error.message : String(error),
      } satisfies PopupResponse)
    })
  return true
})
