import type { ProviderAdapter, Settings, TaskQueue } from './llm.js'

export type ChatRole = 'user' | 'assistant'

export interface ChatTurnRecord {
  turnId: string
  role: ChatRole
  text: string
  /** Compound offer keys validated locally before they reach the UI. */
  offerKeys: string[]
  createdAt: number
}

export interface ChatSyncContext {
  processed: number
  complete: boolean
}

export interface ChatDeps {
  adapter: ProviderAdapter
  settings: Settings
  queue: TaskQueue
  fetchImpl: typeof fetch
  now: () => number
  shouldContinue?: () => boolean
}

export interface ChatAnswer {
  text: string
  offerKeys: string[]
}
