import type { BackfillCheckpoint } from '../types/storage.js'

export const SYNC_INTERVAL_MS = 5 * 60_000
const WATCHDOG_REARM_MS = 20_000

/**
 * Keeps one restart-safe wake in the future while work is active. Re-arming
 * replaces the same named alarm, so a long OCR or provider wait cannot consume
 * the only continuation alarm before Chrome suspends the MV3 worker.
 */
export async function runWithSyncWatchdog<T>(
  arm: () => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  await arm()
  const timer = setInterval(() => {
    void arm().catch(() => undefined)
  }, WATCHDOG_REARM_MS)
  try {
    return await work()
  } finally {
    clearInterval(timer)
  }
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
