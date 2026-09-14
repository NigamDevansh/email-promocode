import type { BackfillCheckpoint } from '../types/storage.js'

/** Bump when extraction behavior changes so stale cache entries are reprocessed. */
export const EXTRACTOR_VERSION = 3

export const META_KEYS = {
  backfill: 'backfill',
  historyId: 'historyId',
  authState: 'authState',
  lastSync: 'lastSync',
} as const

export function initialCheckpoint(query: string): BackfillCheckpoint {
  return {
    status: 'idle',
    query,
    currentPageMessageIds: [],
    nextPageToken: null,
    processedCount: 0,
    extractorVersion: EXTRACTOR_VERSION,
    nextAttemptAt: null,
    attempts: {},
  }
}
