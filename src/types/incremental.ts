/**
 * §6 incremental job, persisted in `meta`.
 *
 * It exists so the discovered message IDs and the cursor they correspond to
 * survive a service-worker shutdown together. Holding them apart is what would
 * allow the cursor to advance past mail that was never parsed.
 */
export interface IncrementalJob {
  /** Discovered by history.list and not yet terminal. */
  pendingMessageIds: string[]
  /** Committed as the new cursor only once `pendingMessageIds` is empty. */
  targetHistoryId: string
  /** Set while history.list still has pages left to walk. */
  pageToken: string | null
  /** Attempts per message ID, so one broken message cannot block new mail. */
  attempts: Record<string, number>
  nextAttemptAt: number | null
}

export interface IncrementalResult {
  /** Message IDs history.list reported this run. */
  discovered: number
  processed: number
  remaining: boolean
  /** True when the cursor expired and §6's full-list fallback must run. */
  fullSyncRequired: boolean
  nextAttemptAt?: number
  error?: string
}
