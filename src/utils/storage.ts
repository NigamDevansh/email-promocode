import type { BackfillCheckpoint } from '../types/storage.js'

/** Bump when extraction behavior changes so stale cache entries are reprocessed. */
export const EXTRACTOR_VERSION = 4

export const META_KEYS = {
  backfill: 'backfill',
  historyId: 'historyId',
  incremental: 'incremental',
  authState: 'authState',
  lastSync: 'lastSync',
  syncBlocked: 'syncBlocked',
} as const

export function initialCheckpoint(query: string): BackfillCheckpoint {
  return {
    status: 'idle',
    query,
    currentPageMessageIds: [],
    nextPageToken: null,
    processedCount: 0,
    extractorVersion: EXTRACTOR_VERSION,
    llmProcessed: false,
    nextAttemptAt: null,
    syncAttempts: 0,
    attempts: {},
  }
}
