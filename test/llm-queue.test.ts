import assert from 'node:assert/strict'
import test from 'node:test'
import { RequestQueue } from '../src/llm/queue.ts'
import { LlmError } from '../src/types/llm.ts'

/** A clock that jumps forward instead of waiting, so pacing is deterministic. */
function fakeClock() {
  let current = 1_000_000
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms
    },
  }
}

function queueWith(minSpacingMs = 1000) {
  const clock = fakeClock()
  return { clock, queue: new RequestQueue({ minSpacingMs, ...clock }) }
}

test('runs one request at a time', async () => {
  const { queue } = queueWith(0)
  let inFlight = 0
  let peak = 0

  await Promise.all(
    Array.from({ length: 5 }, () =>
      queue.run('background', async () => {
        peak = Math.max(peak, ++inFlight)
        await Promise.resolve()
        inFlight--
      }),
    ),
  )

  assert.equal(peak, 1, 'section 6: concurrency 1')
})

test('interactive work jumps ahead of queued backfill', async () => {
  const { queue } = queueWith(0)
  const order: string[] = []

  // The first task occupies the runner while the rest queue behind it.
  const first = queue.run('background', async () => {
    order.push('background-1')
  })
  const second = queue.run('background', async () => {
    order.push('background-2')
  })
  const chat = queue.run('interactive', async () => {
    order.push('chat')
  })
  const third = queue.run('background', async () => {
    order.push('background-3')
  })

  await Promise.all([first, second, chat, third])

  assert.deepEqual(order, ['background-1', 'chat', 'background-2', 'background-3'])
})

test('interactive requests keep their own arrival order', async () => {
  const { queue } = queueWith(0)
  const order: string[] = []

  const blocker = queue.run('background', async () => {
    order.push('blocker')
  })
  const a = queue.run('interactive', async () => {
    order.push('chat-a')
  })
  const b = queue.run('interactive', async () => {
    order.push('chat-b')
  })

  await Promise.all([blocker, a, b])
  assert.deepEqual(order, ['blocker', 'chat-a', 'chat-b'])
})

test('requests are spaced apart rather than bursting', async () => {
  const { clock, queue } = queueWith(2000)
  const startedAt: number[] = []

  await Promise.all(
    Array.from({ length: 3 }, () =>
      queue.run('background', async () => {
        startedAt.push(clock.now())
      }),
    ),
  )

  assert.equal(startedAt.length, 3)
  assert.equal((startedAt[1] ?? 0) - (startedAt[0] ?? 0), 2000)
  assert.equal((startedAt[2] ?? 0) - (startedAt[1] ?? 0), 2000)
})

test('a rate limit pauses everything behind it for the provider reset', async () => {
  const { clock, queue } = queueWith(1000)

  await assert.rejects(() =>
    queue.run('background', async () => {
      throw new LlmError('rate-limit', 'slow down', 429, 60_000)
    }),
  )

  const pausedUntil = queue.pausedUntil
  assert.ok(pausedUntil >= clock.now() + 59_000, 'the whole queue waits, not just the caller')

  let ranAt = 0
  await queue.run('background', async () => {
    ranAt = clock.now()
  })

  assert.ok(ranAt >= pausedUntil, 'section 6: honour the reset before the next request')
})

test('a non-rate-limit failure adds no delay beyond normal spacing', async () => {
  const { clock, queue } = queueWith(0)

  await assert.rejects(() =>
    queue.run('background', async () => {
      throw new LlmError('schema', 'bad json')
    }),
  )

  // With zero spacing the queue is free again immediately; only a rate limit
  // pushes the gate into the future.
  assert.equal(queue.pausedUntil, clock.now(), 'a schema error must not stall the queue')
})

test('one failing request does not break the queue for the next', async () => {
  const { queue } = queueWith(0)

  await assert.rejects(() =>
    queue.run('background', async () => {
      throw new Error('boom')
    }),
  )

  assert.equal(await queue.run('background', async () => 'ok'), 'ok')
})

test('results and errors reach the original caller', async () => {
  const { queue } = queueWith(0)

  const [ok, failed] = await Promise.allSettled([
    queue.run('background', async () => 42),
    queue.run('background', async () => {
      throw new LlmError('auth', 'bad key')
    }),
  ])

  assert.deepEqual(ok, { status: 'fulfilled', value: 42 })
  assert.equal(failed.status, 'rejected')
})
