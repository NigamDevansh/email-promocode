/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving input order
 * in the result. Phase 1 starts at 5 concurrent Gmail message fetches; phase 6
 * adds the persisted alarm-based retry/backoff used by scheduled sync.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, received ${limit}`)
  }

  const results = new Array<R>(items.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return results
}
