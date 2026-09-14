import type { BackfillCheckpoint } from '../types/storage.js'

export const SYNC_INTERVAL_MS = 5 * 60_000

/** Arms a restart-safe wake before work that may outlive the current MV3 worker. */
export async function runWithSyncWatchdog<T>(
  arm: () => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  await arm()
  return await work()
}

export function rollingRefreshIsDue(
  checkpoint: BackfillCheckpoint | undefined,
  lastSync: number | undefined,
  now: number,
  force: boolean = false,
): boolean {
  if (checkpoint?.status !== 'complete') return false
  return force || !lastSync || now - lastSync >= SYNC_INTERVAL_MS
}
