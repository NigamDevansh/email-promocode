import { LlmError } from '../types/llm.js'

/**
 * §6: interactive chat shares the limiter with backfill but jumps ahead of it,
 * so a long first scan never makes a chat turn wait behind every email.
 */
export type Priority = 'interactive' | 'background'

interface Waiting<T = unknown> {
  priority: Priority
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export interface QueueOptions {
  /** Minimum gap between requests. Throughput is not an MVP goal. */
  minSpacingMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/**
 * One serialised provider queue: concurrency 1, conservative spacing, and a
 * shared pause that a 429 can set for everything behind it.
 */
export class RequestQueue {
  private readonly waiting: Waiting[] = []
  private running = false
  private nextAllowedAt = 0

  constructor(private readonly options: QueueOptions) {}

  /** §6: honour a provider reset for every queued request, not just the one that hit it. */
  pauseUntil(timestamp: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, timestamp)
  }

  get pausedUntil(): number {
    return this.nextAllowedAt
  }

  get depth(): number {
    return this.waiting.length
  }

  run<T>(priority: Priority, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting<T> = { priority, task, resolve, reject }

      if (priority === 'interactive') {
        // Ahead of background work, but behind interactive work already waiting.
        const firstBackground = this.waiting.findIndex((item) => item.priority === 'background')
        if (firstBackground === -1) this.waiting.push(entry as Waiting)
        else this.waiting.splice(firstBackground, 0, entry as Waiting)
      } else {
        this.waiting.push(entry as Waiting)
      }

      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      for (;;) {
        const entry = this.waiting.shift()
        if (!entry) return

        const wait = this.nextAllowedAt - this.options.now()
        if (wait > 0) await this.options.sleep(wait)

        try {
          const value = await entry.task()
          entry.resolve(value)
        } catch (error) {
          // A rate limit applies to the whole queue, not just this caller.
          if (error instanceof LlmError && error.kind === 'rate-limit') {
            const delay = error.retryAfterMs ?? this.options.minSpacingMs
            this.pauseUntil(this.options.now() + delay)
          }
          entry.reject(error)
        }

        this.nextAllowedAt = Math.max(
          this.nextAllowedAt,
          this.options.now() + this.options.minSpacingMs,
        )
      }
    } finally {
      this.running = false
    }
  }
}
