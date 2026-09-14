import type { AuthorizedFetchDeps } from '../types/auth.js'
import type { ChatTurnRecord } from '../types/chat.js'
import type { Settings } from '../types/llm.js'
import type {
  AuthState,
  PopupRequest,
  PopupResponse,
  SettingsView,
  SyncProgress,
  SyncStatus,
} from '../types/messaging.js'
import type { BackfillCheckpoint, OfferRecord } from '../types/storage.js'
import type { IncrementalJob } from '../types/incremental.js'
import { answerCouponQuestion } from '../llm/chat.js'
import { adapterFor } from '../llm/index.js'
import { RequestQueue } from '../llm/queue.js'
import { isConfigured, maskApiKey } from '../utils/settings.js'
import { expiryRetentionCutoff } from '../utils/expiry.js'
import { initialCheckpoint, META_KEYS } from '../utils/storage.js'
import { runWithSyncWatchdog, shouldRelistWindow } from '../utils/sync.js'
import { authStateForError, ReauthRequiredError } from './auth.js'
import { runBackfillSlice } from './backfill.js'
import { runIncrementalSlice } from './incremental.js'
import { chromeTokens, requestAuthToken } from './chrome-tokens.js'
import { createGmailPort } from './gmail.js'
import { indexedDbStore } from './idb.js'
import { closeOcrEngine, readImages } from './ocr.js'
import { clearApiKey, readSettings, writeSettings } from './settings.js'
import { readAuthState, writeAuthState } from './state.js'
import { syncRetryDelay } from './sync-errors.js'

const SLICE_BUDGET = 15
const CHAT_HISTORY_LIMIT = 20
const PERIODIC_SYNC_ALARM = 'periodic-coupon-sync'
const RESUME_SYNC_ALARM = 'resume-coupon-sync'

const gmailDeps: AuthorizedFetchDeps = {
  tokens: chromeTokens,
  fetchImpl: (...args) => fetch(...args),
  onReauthRequired: () => writeAuthState('reauth_required'),
}

const llmQueue = new RequestQueue({
  minSpacingMs: 1200,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

let settingsRevision = 0
let inFlightSync: Promise<SyncProgress> | undefined
let chatTail: Promise<void> = Promise.resolve()

async function ensurePeriodicSync(): Promise<void> {
  if (await chrome.alarms.get(PERIODIC_SYNC_ALARM)) return
  await chrome.alarms.create(PERIODIC_SYNC_ALARM, {
    delayInMinutes: 5,
    periodInMinutes: 5,
  })
}

async function scheduleSync(when: number = Date.now() + 30_000): Promise<void> {
  await chrome.alarms.create(RESUME_SYNC_ALARM, {
    when: Math.max(Date.now() + 30_000, when),
  })
}

async function requestRefreshIfDue(force: boolean = false): Promise<void> {
  if (inFlightSync) return

  const [checkpoint, historyCursor, lastSync, settings] = await Promise.all([
    indexedDbStore.getMeta<BackfillCheckpoint>(META_KEYS.backfill),
    indexedDbStore.getMeta<string>(META_KEYS.historyId),
    indexedDbStore.getMeta<number>(META_KEYS.lastSync),
    readSettings(),
  ])
  if (!shouldRelistWindow({ checkpoint, historyCursor, lastSync, now: Date.now(), force })) return

  await indexedDbStore.setMeta(
    META_KEYS.backfill,
    initialCheckpoint(`newer_than:${settings.backfillDays}d`),
  )
}

async function currentAuthState(): Promise<AuthState> {
  const stored = await readAuthState()
  if (stored === 'reauth_required') return stored

  const token = await chromeTokens.get(false)
  const state: AuthState = token ? 'connected' : 'disconnected'
  if (state !== stored) await writeAuthState(state)
  return state
}

async function connect(): Promise<PopupResponse> {
  const { token, error } = await requestAuthToken(true)
  if (!token) {
    await writeAuthState('disconnected')
    return {
      ok: false,
      authState: 'disconnected',
      error: error ?? 'Google sign-in was dismissed before it completed.',
    }
  }

  await writeAuthState('connected')
  await indexedDbStore.setMeta(META_KEYS.syncBlocked, null)
  await requestRefreshIfDue(true)
  await scheduleSync()
  void runAutomaticSync()
  return { ok: true, authState: 'connected' }
}

function soonest(...times: (number | undefined)[]): number | undefined {
  const known = times.filter((time): time is number => typeof time === 'number')
  return known.length > 0 ? Math.min(...known) : undefined
}

async function runSync(): Promise<SyncProgress> {
  const settings = await readSettings()
  const revision = settingsRevision
  const shared = {
    store: indexedDbStore,
    gmail: createGmailPort(gmailDeps),
    now: () => Date.now(),
    shouldContinue: () => revision === settingsRevision,
    backfillDays: settings.backfillDays,
    // §7 phase 7: always part of the cascade, never a setting.
    ocr: readImages,
    llm: isConfigured(settings)
      ? {
        adapter: adapterFor(settings.provider),
        settings,
        queue: llmQueue,
        fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
      }
      : undefined,
  }

  try {
    await indexedDbStore.deleteExpiredOffers(expiryRetentionCutoff(new Date()))
    // §6 step 7: new mail first, then a bounded slice of the older backfill, so
    // today's coupons never wait behind hundreds of historical messages.
    const incremental = await runIncrementalSlice({ ...shared, budget: SLICE_BUDGET })

    if (incremental.fullSyncRequired) {
      // The cursor outlived Gmail's retention. §6 calls the 45-day re-list routine.
      await indexedDbStore.setMeta(META_KEYS.backfill, undefined)
    }

    const result = await runBackfillSlice({
      ...shared,
      budget: Math.max(0, SLICE_BUDGET - incremental.processed),
    })
    const checkpoint = await indexedDbStore.getMeta<BackfillCheckpoint>(META_KEYS.backfill)

    return {
      processed: result.processed + incremental.processed,
      skipped: result.skipped,
      withCandidates: result.withCandidates,
      totalProcessed: checkpoint?.processedCount ?? 0,
      remaining: result.remaining || incremental.remaining,
      nextAttemptAt: soonest(result.nextAttemptAt, incremental.nextAttemptAt),
      error: result.error ?? incremental.error,
    }
  } finally {
    await closeOcrEngine().catch(() => undefined)
  }
}

function syncOnce(): Promise<SyncProgress> {
  inFlightSync ??= runSync().finally(() => {
    inFlightSync = undefined
  })
  return inFlightSync
}

async function persistSyncRetry(error: unknown): Promise<boolean> {
  const [checkpoint, settings] = await Promise.all([
    indexedDbStore.getMeta<BackfillCheckpoint>(META_KEYS.backfill),
    readSettings(),
  ])
  const syncAttempts = (checkpoint?.syncAttempts ?? 0) + 1
  const delayMs = syncRetryDelay(error, syncAttempts)
  if (delayMs === null) return false

  const nextAttemptAt = Date.now() + delayMs
  await indexedDbStore.setMeta(META_KEYS.backfill, {
    ...(checkpoint ?? initialCheckpoint(`newer_than:${settings.backfillDays}d`)),
    nextAttemptAt,
    syncAttempts,
  })
  await scheduleSync(nextAttemptAt)
  return true
}

async function clearSyncRetryAttempts(): Promise<void> {
  const checkpoint = await indexedDbStore.getMeta<BackfillCheckpoint>(META_KEYS.backfill)
  if (!checkpoint?.syncAttempts) return
  await indexedDbStore.setMeta(META_KEYS.backfill, { ...checkpoint, syncAttempts: 0 })
}

async function runAutomaticSync(): Promise<void> {
  if ((await readAuthState()) !== 'connected') return
  if (await indexedDbStore.getMeta<string | null>(META_KEYS.syncBlocked)) return
  const checkpoint = await indexedDbStore.getMeta<BackfillCheckpoint>(META_KEYS.backfill)
  if (checkpoint?.nextAttemptAt && checkpoint.nextAttemptAt > Date.now()) {
    await scheduleSync(checkpoint.nextAttemptAt)
    return
  }

  try {
    const result = await runWithSyncWatchdog(
      () => scheduleSync(),
      () => syncOnce(),
    )
    await clearSyncRetryAttempts()
    await indexedDbStore.setMeta(META_KEYS.lastSync, Date.now())
    if (result.remaining) await scheduleSync(result.nextAttemptAt)
    else await chrome.alarms.clear(RESUME_SYNC_ALARM)
  } catch (error) {
    const authState = authStateForError(error)
    if (authState) {
      await writeAuthState(authState)
      return
    }

    if (await persistSyncRetry(error)) return

    const message = error instanceof Error ? error.message : String(error)
    await indexedDbStore.setMeta(META_KEYS.syncBlocked, message)
  }
}

async function syncStatus(): Promise<SyncStatus> {
  const [checkpoint, incremental, settings, blocked] = await Promise.all([
    indexedDbStore.getMeta<BackfillCheckpoint>(META_KEYS.backfill),
    indexedDbStore.getMeta<IncrementalJob>(META_KEYS.incremental),
    readSettings(),
    indexedDbStore.getMeta<string | null>(META_KEYS.syncBlocked),
  ])
  const totalProcessed = checkpoint?.processedCount ?? 0

  if (blocked) return { state: 'blocked', totalProcessed, message: blocked }
  if (inFlightSync) return { state: 'loading', totalProcessed }

  const needsLlmPass = isConfigured(settings) && checkpoint?.llmProcessed !== true
  const hasWork =
    !checkpoint ||
    checkpoint.status !== 'complete' ||
    needsLlmPass ||
    incremental !== undefined
  if (!hasWork) return { state: 'ready', totalProcessed }

  const nextAttemptAt = soonest(
    checkpoint?.nextAttemptAt ?? undefined,
    incremental?.nextAttemptAt ?? undefined,
  )
  if (nextAttemptAt && nextAttemptAt > Date.now()) {
    return {
      state: 'waiting',
      totalProcessed,
      nextAttemptAt,
    }
  }
  return { state: 'loading', totalProcessed }
}

function settingsView(settings: Settings): SettingsView {
  return {
    provider: settings.provider,
    model: settings.model,
    hasApiKey: settings.apiKey.length > 0,
    apiKeyMasked: maskApiKey(settings.apiKey),
  }
}

async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const settings = await writeSettings(patch)
  settingsRevision += 1
  await indexedDbStore.setMeta(META_KEYS.syncBlocked, null)
  if ((await readAuthState()) === 'connected') {
    await scheduleSync()
    void runAutomaticSync()
  }
  return settings
}

async function removeApiKey(): Promise<Settings> {
  const settings = await clearApiKey()
  settingsRevision += 1
  await indexedDbStore.setMeta(META_KEYS.syncBlocked, null)
  if ((await readAuthState()) === 'connected') {
    await scheduleSync()
    void runAutomaticSync()
  }
  return settings
}

async function chatSnapshot(): Promise<{
  chatTurns: ChatTurnRecord[]
  offers: OfferRecord[]
}> {
  const [chatTurns, offers] = await Promise.all([
    indexedDbStore.listChatTurns(),
    indexedDbStore.listOffers(),
  ])
  return { chatTurns, offers }
}

async function sendChat(question: string): Promise<PopupResponse> {
  if ((await readAuthState()) !== 'connected') throw new ReauthRequiredError()

  const settings = await readSettings()
  if (!isConfigured(settings)) {
    throw new Error('Add an LLM API key from Settings to start chatting.')
  }

  const revision = settingsRevision
  const [offers, history, checkpoint] = await Promise.all([
    indexedDbStore.listOffers(),
    indexedDbStore.listChatTurns(),
    indexedDbStore.getMeta<BackfillCheckpoint>(META_KEYS.backfill),
  ])
  const answer = await answerCouponQuestion(
    question,
    offers,
    history,
    {
      processed: checkpoint?.processedCount ?? 0,
      complete: checkpoint?.status === 'complete' && checkpoint.llmProcessed === true,
    },
    {
      adapter: adapterFor(settings.provider),
      settings,
      queue: llmQueue,
      fetchImpl: (...args) => fetch(...args),
      now: () => Date.now(),
      shouldContinue: () => revision === settingsRevision,
    },
  )

  const now = Date.now()
  const additions: ChatTurnRecord[] = [
    {
      turnId: crypto.randomUUID(),
      role: 'user',
      text: question.trim().slice(0, 500),
      offerKeys: [],
      createdAt: now,
    },
    {
      turnId: crypto.randomUUID(),
      role: 'assistant',
      text: answer.text,
      offerKeys: answer.offerKeys,
      createdAt: now + 1,
    },
  ]
  const turns = [...history, ...additions].slice(-CHAT_HISTORY_LIMIT)
  await indexedDbStore.replaceChatTurns(turns)

  return {
    ok: true,
    authState: 'connected',
    ...(await chatSnapshot()),
  }
}

function queueChat(question: string): Promise<PopupResponse> {
  const result = chatTail.then(() => sendChat(question))
  chatTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function handle(request: PopupRequest): Promise<PopupResponse> {
  switch (request.type) {
    case 'get-state': {
      const authState = await currentAuthState()
      if (authState === 'connected') {
        await requestRefreshIfDue()
        await scheduleSync()
        void runAutomaticSync()
      }
      return { ok: true, authState }
    }
    case 'connect':
      return await connect()
    case 'get-sync-status':
      return { ok: true, authState: await readAuthState(), syncStatus: await syncStatus() }
    case 'get-chat':
      return { ok: true, authState: await readAuthState(), ...(await chatSnapshot()) }
    case 'send-chat':
      return await queueChat(request.question)
    case 'get-settings':
      return {
        ok: true,
        authState: await readAuthState(),
        settings: settingsView(await readSettings()),
      }
    case 'save-settings':
      return {
        ok: true,
        authState: await readAuthState(),
        settings: settingsView(await updateSettings(request.settings)),
      }
    case 'clear-api-key':
      return {
        ok: true,
        authState: await readAuthState(),
        settings: settingsView(await removeApiKey()),
      }
  }
}

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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_SYNC_ALARM || alarm.name === RESUME_SYNC_ALARM) {
    void (async () => {
      if (alarm.name === PERIODIC_SYNC_ALARM) await requestRefreshIfDue(true)
      await runAutomaticSync()
    })().catch(() => undefined)
  }
})

chrome.runtime.onInstalled.addListener(() => {
  void ensurePeriodicSync()
    .then(async () => {
      await scheduleSync()
      await runAutomaticSync()
    })
    .catch(() => undefined)
})

chrome.runtime.onStartup.addListener(() => {
  void ensurePeriodicSync()
    .then(async () => {
      await scheduleSync()
      await runAutomaticSync()
    })
    .catch(() => undefined)
})

void ensurePeriodicSync().catch(() => undefined)
