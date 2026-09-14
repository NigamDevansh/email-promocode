import type {
  AuthState,
  PopupRequest,
  PopupResponse,
  SyncProgress,
} from '../types/messaging.js'
import type { AuthorizedFetchDeps } from '../types/auth.js'
import type { BackfillCheckpoint } from '../types/storage.js'
import { META_KEYS } from '../utils/storage.js'
import { authStateForError, ReauthRequiredError } from './auth.js'
import { runBackfillSlice } from './backfill.js'
import { chromeTokens, requestAuthToken } from './chrome-tokens.js'
import { BACKFILL_DAYS, createGmailPort, listPromotionSummaries } from './gmail.js'
import { indexedDbStore } from './idb.js'
import { readAuthState, writeAuthState } from './state.js'

/** Keep the popup preview small; the backfill uses its own paginated listing. */
const POPUP_MESSAGE_LIMIT = 25

/** Section 6: bounded work per wake, so a checkpoint always lands before Chrome stops the worker. */
const SLICE_BUDGET = 15

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
async function connect(): Promise<PopupResponse> {
  const { token, error } = await requestAuthToken(true)

  if (token) {
    await writeAuthState('connected')
    return { ok: true, authState: 'connected' }
  }

  await writeAuthState('disconnected')
  return {
    ok: false,
    authState: 'disconnected',
    error: error ?? 'Google sign-in was dismissed before it completed.',
  }
}

async function runSync(): Promise<SyncProgress> {
  const result = await runBackfillSlice({
    store: indexedDbStore,
    gmail: createGmailPort(deps),
    now: () => Date.now(),
    budget: SLICE_BUDGET,
    backfillDays: BACKFILL_DAYS,
  })

  const checkpoint = await indexedDbStore.getMeta<BackfillCheckpoint>(META_KEYS.backfill)

  return {
    processed: result.processed,
    skipped: result.skipped,
    withCandidates: result.withCandidates,
    totalProcessed: checkpoint?.processedCount ?? 0,
    remaining: result.remaining,
    nextAttemptAt: result.nextAttemptAt,
    error: result.error,
  }
}

let inFlightSync: Promise<SyncProgress> | undefined

/**
 * Section 6: coalesce overlapping requests into the run already in flight.
 * There is only one extension service-worker instance, so no lock is needed.
 */
function syncOnce(): Promise<SyncProgress> {
  inFlightSync ??= runSync().finally(() => {
    inFlightSync = undefined
  })
  return inFlightSync
}

async function handle(request: PopupRequest): Promise<PopupResponse> {
  switch (request.type) {
    case 'get-state':
      return { ok: true, authState: await currentAuthState() }

    case 'connect':
      return await connect()

    case 'list-messages': {
      if ((await readAuthState()) === 'reauth_required') throw new ReauthRequiredError()
      const messages = await listPromotionSummaries(deps, POPUP_MESSAGE_LIMIT)
      await writeAuthState('connected')
      return { ok: true, authState: 'connected', messages }
    }

    case 'list-offers': {
      return { ok: true, authState: await readAuthState(), offers: await indexedDbStore.listOffers() }
    }

    case 'sync': {
      if ((await readAuthState()) === 'reauth_required') throw new ReauthRequiredError()
      return { ok: true, authState: 'connected', progress: await syncOnce() }
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
