import type { ChatTurnRecord } from '../types/chat.js'
import type { OfferRecord, ProcessedRecord, Store } from '../types/storage.js'
import { mergeOffer } from '../utils/offers.js'

const DB_NAME = 'inbox-coupon-assistant'
const DB_VERSION = 1

const OFFERS = 'offers'
const PROCESSED = 'processed'
const META = 'meta'
const CHAT = 'chat'

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Resolves when the transaction commits, rejecting if it errors or aborts. */
function finished(transaction: IDBTransaction, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error(`${what} aborted`))
  })
}

/**
 * All four §9 stores are created up front even though `offers` is written from
 * phase 3 and `chat` from phase 5 — adding them later would need a version
 * migration for no benefit.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(OFFERS)) {
        const offers = db.createObjectStore(OFFERS, { keyPath: ['brandKey', 'normalizedCode'] })
        offers.createIndex('brandKey', 'brandKey')
        offers.createIndex('expiry', 'expiry')
        offers.createIndex('normalizedCode', 'normalizedCode')
      }
      if (!db.objectStoreNames.contains(PROCESSED)) {
        db.createObjectStore(PROCESSED, { keyPath: 'messageId' })
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(CHAT)) {
        db.createObjectStore(CHAT, { keyPath: 'turnId' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function isDeadConnection(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false
  if (error.name === 'AbortError') return true
  return error.name === 'InvalidStateError' && /database connection is closing/i.test(error.message)
}

export function createIdbStore(open: () => Promise<IDBDatabase> = openDatabase): Store {
  let connection: Promise<IDBDatabase> | undefined

  /**
   * The worker is restarted often, so the handle is cached per worker lifetime —
   * but only for as long as it is alive. `close` and `versionchange` drop it so
   * the next call opens a new one instead of throwing on a dead one.
   */
  function database(): Promise<IDBDatabase> {
    if (connection) return connection

    const pending = open().then(
      (db) => {
        const forget = (): void => {
          if (connection === pending) connection = undefined
        }
        db.onclose = forget
        db.onversionchange = () => {
          db.close()
          forget()
        }
        return db
      },
      (error: unknown) => {
        if (connection === pending) connection = undefined
        throw error
      },
    )

    connection = pending
    return pending
  }

  async function withTransaction<T>(
    stores: string | string[],
    mode: IDBTransactionMode,
    run: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const pending = database()
      const db = await pending

      try {
        return await run(db.transaction(stores, mode))
      } catch (error) {
        if (attempt > 0 || !isDeadConnection(error)) throw error
        if (connection === pending) connection = undefined
      }
    }
  }

  return {
    getProcessed(messageId) {
      return withTransaction(PROCESSED, 'readonly', (transaction) =>
        promisify<ProcessedRecord | undefined>(
          transaction.objectStore(PROCESSED).get(messageId) as IDBRequest<
            ProcessedRecord | undefined
          >,
        ),
      )
    },

    commitMessage(record, offers) {
      return withTransaction([OFFERS, PROCESSED], 'readwrite', async (transaction) => {
        const done = finished(transaction, 'commit')

        const offerStore = transaction.objectStore(OFFERS)
        for (const offer of offers) {
          // Read-modify-write inside the same transaction. The put is issued from
          // the success callback, so the transaction is guaranteed still active.
          const lookup = offerStore.get([offer.brandKey, offer.normalizedCode])
          lookup.onsuccess = () => {
            offerStore.put(mergeOffer(lookup.result as OfferRecord | undefined, offer))
          }
        }
        transaction.objectStore(PROCESSED).put(record)

        await done
      })
    },

    listOffers() {
      return withTransaction(OFFERS, 'readonly', (transaction) =>
        promisify<OfferRecord[]>(
          transaction.objectStore(OFFERS).getAll() as IDBRequest<OfferRecord[]>,
        ),
      )
    },

    deleteStaleOffers(extractorVersion, requireLlm) {
      return withTransaction(OFFERS, 'readwrite', async (transaction) => {
        const done = finished(transaction, 'offer cleanup')

        const request = transaction.objectStore(OFFERS).openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return

          const offer = cursor.value as Partial<OfferRecord>
          if (
            offer.extractorVersion !== extractorVersion ||
            (requireLlm && offer.llmProcessed !== true)
          ) {
            cursor.delete()
          }
          cursor.continue()
        }
        await done
      })
    },

    deleteExpiredOffers(before) {
      return withTransaction(OFFERS, 'readwrite', async (transaction) => {
        const done = finished(transaction, 'expired-offer cleanup')

        const expiry = transaction.objectStore(OFFERS).index('expiry')
        const request = expiry.openCursor(IDBKeyRange.upperBound(before, true))
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return

          const offer = cursor.value as OfferRecord
          // The index is chronological because validated dates are YYYY-MM-DD.
          if (typeof offer.expiry === 'string' && offer.expiry < before) cursor.delete()
          cursor.continue()
        }
        await done
      })
    },

    async listChatTurns() {
      const turns = await withTransaction(CHAT, 'readonly', (transaction) =>
        promisify<ChatTurnRecord[]>(
          transaction.objectStore(CHAT).getAll() as IDBRequest<ChatTurnRecord[]>,
        ),
      )
      return turns.sort((left, right) => left.createdAt - right.createdAt)
    },

    replaceChatTurns(turns) {
      return withTransaction(CHAT, 'readwrite', async (transaction) => {
        const done = finished(transaction, 'chat update')

        const chatStore = transaction.objectStore(CHAT)
        chatStore.clear()
        for (const turn of turns) chatStore.put(turn)
        await done
      })
    },

    async getMeta<T>(key: string) {
      const row = await withTransaction(META, 'readonly', (transaction) =>
        promisify<{ key: string; value: T } | undefined>(
          transaction.objectStore(META).get(key) as IDBRequest<
            { key: string; value: T } | undefined
          >,
        ),
      )
      return row?.value
    },

    setMeta<T>(key: string, value: T) {
      return withTransaction(META, 'readwrite', async (transaction) => {
        const done = finished(transaction, 'meta write')
        transaction.objectStore(META).put({ key, value })
        await done
      })
    },
  }
}

export const indexedDbStore: Store = createIdbStore()
