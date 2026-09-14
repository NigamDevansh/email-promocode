import type {
  AuthState,
  PopupRequest,
  PopupResponse,
  SettingsView,
  SyncProgress,
} from '../types/messaging.js'
import type { AuthorizedFetchDeps } from '../types/auth.js'
import type { Settings } from '../types/llm.js'
import { maskApiKey } from '../utils/settings.js'
import type { BackfillCheckpoint } from '../types/storage.js'
import { META_KEYS } from '../utils/storage.js'
import { authStateForError, ReauthRequiredError } from './auth.js'
import { adapterFor } from '../llm/index.js'
import { RequestQueue } from '../llm/queue.js'
import { isConfigured } from '../utils/settings.js'
import { runBackfillSlice } from './backfill.js'
import { chromeTokens, requestAuthToken } from './chrome-tokens.js'
import { createGmailPort, listPromotionSummaries } from './gmail.js'
import { indexedDbStore } from './idb.js'
import { clearApiKey, readSettings, writeSettings } from './settings.js'
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

/**
 * §6: one provider queue for the whole worker. Chat will share this instance so
 * an interactive turn can jump ahead of queued backfill work.
 */
const llmQueue = new RequestQueue({
  minSpacingMs: 1200,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

let settingsRevision = 0

async function runSync(): Promise<SyncProgress> {
  const settings = await readSettings()
  const revision = settingsRevision

  const result = await runBackfillSlice({
    store: indexedDbStore,
    gmail: createGmailPort(deps),
    now: () => Date.now(),
    shouldContinue: () => revision === settingsRevision,
    budget: SLICE_BUDGET,
    backfillDays: settings.backfillDays,
    llm: isConfigured(settings)
      ? {
          adapter: adapterFor(settings.provider),
          settings,
          queue: llmQueue,
          fetchImpl: (...args) => fetch(...args),
        }
      : undefined,
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

/** Strips the stored key down to a mask before it leaves the worker. */
function viewOf(settings: Settings): SettingsView {
  return {
    provider: settings.provider,
    model: settings.model,
    backfillDays: settings.backfillDays,
    enableOcr: settings.enableOcr,
    fetchRemoteImages: settings.fetchRemoteImages,
    hasApiKey: settings.apiKey.length > 0,
    apiKeyMasked: maskApiKey(settings.apiKey),
  }
}

async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const after = await writeSettings(patch)
  settingsRevision += 1
  return after
}

async function removeApiKey(): Promise<Settings> {
  const settings = await clearApiKey()
  settingsRevision += 1
  return settings
}

async function handle(request: PopupRequest): Promise<PopupResponse> {
  switch (request.type) {
    case 'get-state':
      return { ok: true, authState: await currentAuthState() }

    case 'connect':
      return await connect()

    case 'list-messages': {
      if ((await readAuthState()) === 'reauth_required') throw new ReauthRequiredError()
      const settings = await readSettings()
      const messages = await listPromotionSummaries(
        deps,
        POPUP_MESSAGE_LIMIT,
        settings.backfillDays,
      )
      await writeAuthState('connected')
      return { ok: true, authState: 'connected', messages }
    }

    case 'list-offers': {
      return { ok: true, authState: await readAuthState(), offers: await indexedDbStore.listOffers() }
    }

    case 'get-settings':
      return { ok: true, authState: await readAuthState(), settings: viewOf(await readSettings()) }

    case 'save-settings':
      return {
        ok: true,
        authState: await readAuthState(),
        settings: viewOf(await updateSettings(request.settings)),
      }

    case 'clear-api-key':
      return { ok: true, authState: await readAuthState(), settings: viewOf(await removeApiKey()) }

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
