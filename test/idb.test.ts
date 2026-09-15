import assert from 'node:assert/strict'
import test from 'node:test'
import { createIdbStore } from '../src/background/idb.ts'

/*
 * Chrome closes the IndexedDB connection out from under a suspended MV3 worker.
 * The handle is cached for the worker's lifetime, so every call after that used
 * to throw "The database connection is closing" until the worker was restarted:
 * connecting, syncing and chatting all died on a stale object.
 *
 * Node has no IndexedDB, so the store takes an injectable opener and these
 * tests drive the one behaviour that matters — what happens when the handle
 * turns out to be dead.
 */

type Handler = ((event: Event) => unknown) | null

function fakeRequest<T>(result: T): IDBRequest<T> {
  const request = { result, onsuccess: null as Handler, onerror: null as Handler }
  // Fires after the caller has had a chance to attach its handlers.
  queueMicrotask(() => request.onsuccess?.(new Event('success')))
  return request as unknown as IDBRequest<T>
}

interface FakeDatabase {
  db: IDBDatabase
  closed: boolean
}

/** A database whose `transaction()` runs `guard` first, so it can refuse. */
function fakeDatabase(rows: Map<string, unknown>, guard: () => void): FakeDatabase {
  const state: FakeDatabase = { db: null as unknown as IDBDatabase, closed: false }

  state.db = {
    onclose: null as Handler,
    onversionchange: null as Handler,
    close(): void {
      state.closed = true
    },
    transaction(): IDBTransaction {
      guard()

      const transaction = {
        oncomplete: null as Handler,
        onerror: null as Handler,
        onabort: null as Handler,
        error: null,
        objectStore: () => ({
          get: (key: string) => fakeRequest(rows.get(key)),
          put: (row: { key: string }) => {
            rows.set(row.key, row)
            return fakeRequest(undefined)
          },
        }),
      }

      queueMicrotask(() => transaction.oncomplete?.(new Event('complete')))
      return transaction as unknown as IDBTransaction
    },
  } as unknown as IDBDatabase

  return state
}

const closingError = (): DOMException =>
  new DOMException('The database connection is closing.', 'InvalidStateError')

test('a connection Chrome closed under us is reopened instead of thrown', async () => {
  const rows = new Map<string, unknown>([['historyId', { key: 'historyId', value: '9000' }]])
  let opens = 0
  let refuseOnce = true

  const store = createIdbStore(async () => {
    opens += 1
    return fakeDatabase(rows, () => {
      if (!refuseOnce) return
      refuseOnce = false
      throw closingError()
    }).db
  })

  assert.equal(await store.getMeta('historyId'), '9000')
  assert.equal(opens, 2, 'the dead handle was dropped and a fresh one opened')
})

test('a write survives the same death, because nothing was committed', async () => {
  const rows = new Map<string, unknown>()
  let refuseOnce = true

  const store = createIdbStore(async () =>
    fakeDatabase(rows, () => {
      if (!refuseOnce) return
      refuseOnce = false
      throw closingError()
    }).db,
  )

  await store.setMeta('historyId', '9100')
  assert.deepEqual(rows.get('historyId'), { key: 'historyId', value: '9100' })
})

test('the reopened handle is cached, not reopened for every later call', async () => {
  const rows = new Map<string, unknown>()
  let opens = 0
  let refuseOnce = true

  const store = createIdbStore(async () => {
    opens += 1
    return fakeDatabase(rows, () => {
      if (!refuseOnce) return
      refuseOnce = false
      throw closingError()
    }).db
  })

  await store.getMeta('a')
  await store.getMeta('b')
  await store.getMeta('c')

  assert.equal(opens, 2, 'one recovery, then the handle is reused')
})

test('a connection that stays dead gives up rather than looping', async () => {
  let opens = 0
  const store = createIdbStore(async () => {
    opens += 1
    return fakeDatabase(new Map(), () => {
      throw closingError()
    }).db
  })

  await assert.rejects(() => store.getMeta('historyId'), /connection is closing/)
  assert.equal(opens, 2, 'exactly one retry: a second failure is a real fault')
})

test('a genuine storage fault is reported, not retried', async () => {
  let opens = 0
  const store = createIdbStore(async () => {
    opens += 1
    return fakeDatabase(new Map(), () => {
      throw new DOMException('bad key', 'DataError')
    }).db
  })

  await assert.rejects(() => store.getMeta('historyId'), /bad key/)
  assert.equal(opens, 1, 'reopening cannot fix a malformed request')
})

test('an unrelated invalid state is reported, not treated as a dead connection', async () => {
  let opens = 0
  const store = createIdbStore(async () => {
    opens += 1
    return fakeDatabase(new Map(), () => {
      throw new DOMException('The transaction is not active.', 'InvalidStateError')
    }).db
  })

  await assert.rejects(() => store.getMeta('historyId'), /transaction is not active/)
  assert.equal(opens, 1)
})

test('the close event drops the handle so the next call opens a live one', async () => {
  const rows = new Map<string, unknown>()
  const opened: FakeDatabase[] = []

  const store = createIdbStore(async () => {
    const fake = fakeDatabase(rows, () => undefined)
    opened.push(fake)
    return fake.db
  })

  await store.getMeta('historyId')
  assert.equal(opened.length, 1)

  // Chrome closing the connection while the worker idles.
  const handler = opened[0]?.db.onclose as unknown as Handler
  handler?.(new Event('close'))

  await store.getMeta('historyId')
  assert.equal(opened.length, 2, 'the cached handle was discarded when it died')
})

test('a version change closes this connection before letting go of it', async () => {
  const rows = new Map<string, unknown>()
  const opened: FakeDatabase[] = []

  const store = createIdbStore(async () => {
    const fake = fakeDatabase(rows, () => undefined)
    opened.push(fake)
    return fake.db
  })

  await store.getMeta('historyId')
  const first = opened[0]
  ;(first?.db.onversionchange as unknown as Handler)?.(new Event('versionchange'))

  assert.equal(first?.closed, true, 'otherwise the upgrade in the other context blocks')

  await store.getMeta('historyId')
  assert.equal(opened.length, 2)
})
