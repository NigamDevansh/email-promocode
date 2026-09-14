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

let connection: Promise<IDBDatabase> | undefined

/** The worker is restarted often; the handle is cached per worker lifetime. */
function database(): Promise<IDBDatabase> {
  connection ??= openDatabase()
  return connection
}

export const indexedDbStore: Store = {
  async getProcessed(messageId) {
    const db = await database()
    const transaction = db.transaction(PROCESSED, 'readonly')
    return await promisify<ProcessedRecord | undefined>(
      transaction.objectStore(PROCESSED).get(messageId) as IDBRequest<ProcessedRecord | undefined>,
    )
  },

  async commitMessage(record, offers) {
    const db = await database()
    const transaction = db.transaction([OFFERS, PROCESSED], 'readwrite')

    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('commit aborted'))
    })

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
  },

  async listOffers() {
    const db = await database()
    const transaction = db.transaction(OFFERS, 'readonly')
    return await promisify<OfferRecord[]>(
      transaction.objectStore(OFFERS).getAll() as IDBRequest<OfferRecord[]>,
    )
  },

  async deleteOffersExceptVersion(extractorVersion) {
    const db = await database()
    const transaction = db.transaction(OFFERS, 'readwrite')
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('offer cleanup aborted'))
    })

    const request = transaction.objectStore(OFFERS).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return

      const offer = cursor.value as Partial<OfferRecord>
      if (offer.extractorVersion !== extractorVersion) cursor.delete()
      cursor.continue()
    }
    await done
  },

  async getMeta<T>(key: string) {
    const db = await database()
    const transaction = db.transaction(META, 'readonly')
    const row = await promisify<{ key: string; value: T } | undefined>(
      transaction.objectStore(META).get(key) as IDBRequest<{ key: string; value: T } | undefined>,
    )
    return row?.value
  },

  async setMeta<T>(key: string, value: T) {
    const db = await database()
    const transaction = db.transaction(META, 'readwrite')

    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('meta write aborted'))
    })

    transaction.objectStore(META).put({ key, value })
    await done
  },
}
