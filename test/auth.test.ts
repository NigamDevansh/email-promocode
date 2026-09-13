import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizedFetch,
  NotConnectedError,
  ReauthRequiredError,
} from '../src/background/auth.ts'
import type { AuthorizedFetchDeps, TokenPort } from '../src/types/auth.ts'

const URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

/** Hands out the given tokens in order, then null forever. */
function harness(tokens: (string | null)[], statuses: number[]) {
  const removed: string[] = []
  const sent: (string | undefined)[] = []
  let reauthCalls = 0
  let tokenCalls = 0

  const port: TokenPort = {
    async get() {
      return tokens[tokenCalls++] ?? null
    },
    async remove(token) {
      removed.push(token)
    },
  }

  const deps: AuthorizedFetchDeps = {
    tokens: port,
    fetchImpl: async (_url, init) => {
      sent.push(new Headers(init?.headers).get('Authorization') ?? undefined)
      return new Response(null, { status: statuses[sent.length - 1] ?? 200 })
    },
    onReauthRequired: async () => {
      reauthCalls++
    },
  }

  return {
    deps,
    removed,
    sent,
    get reauthCalls() {
      return reauthCalls
    },
  }
}

test('passes a bearer token through and returns a successful response', async () => {
  const h = harness(['token-a'], [200])
  const response = await authorizedFetch(URL, h.deps)

  assert.equal(response.status, 200)
  assert.deepEqual(h.sent, ['Bearer token-a'])
  assert.deepEqual(h.removed, [])
  assert.equal(h.reauthCalls, 0)
})

test('preserves caller headers while setting authorization', async () => {
  let receivedHeaders = new Headers()
  const h = harness(['token-a'], [200])
  h.deps.fetchImpl = async (_url, init) => {
    receivedHeaders = new Headers(init?.headers)
    return new Response(null, { status: 200 })
  }

  await authorizedFetch(URL, h.deps, { headers: new Headers({ Accept: 'application/json' }) })

  assert.equal(receivedHeaders.get('Accept'), 'application/json')
  assert.equal(receivedHeaders.get('Authorization'), 'Bearer token-a')
})

test('no token at all is "not connected", not a reauth-required state', async () => {
  const h = harness([null], [])

  await assert.rejects(() => authorizedFetch(URL, h.deps), NotConnectedError)
  assert.equal(h.sent.length, 0, 'must not call Gmail without a token')
  assert.equal(h.reauthCalls, 0, 'a fresh install is not a terminal auth failure')
})

test('recovers from a single 401 by dropping the token and retrying once', async () => {
  const h = harness(['stale', 'fresh'], [401, 200])
  const response = await authorizedFetch(URL, h.deps)

  assert.equal(response.status, 200)
  assert.deepEqual(h.removed, ['stale'])
  assert.deepEqual(h.sent, ['Bearer stale', 'Bearer fresh'])
  assert.equal(h.reauthCalls, 0)
})

test('a second 401 is terminal and does not loop', async () => {
  const h = harness(['stale', 'also-stale', 'never-used'], [401, 401, 200])

  await assert.rejects(() => authorizedFetch(URL, h.deps), ReauthRequiredError)
  assert.equal(h.sent.length, 2, 'exactly one retry, never a retry loop')
  assert.deepEqual(h.removed, ['stale', 'also-stale'], 'both rejected tokens are evicted')
  assert.equal(h.reauthCalls, 1, 'reauth_required is persisted exactly once')
})

test('a cache-removal failure enters reauth-required without retrying the rejected token', async () => {
  let reauthCalls = 0
  let fetchCalls = 0
  const deps: AuthorizedFetchDeps = {
    tokens: {
      async get() {
        return 'stale'
      },
      async remove() {
        throw new Error('Chrome token cache unavailable')
      },
    },
    async fetchImpl() {
      fetchCalls++
      return new Response(null, { status: 401 })
    },
    async onReauthRequired() {
      reauthCalls++
    },
  }

  await assert.rejects(() => authorizedFetch(URL, deps), ReauthRequiredError)
  assert.equal(fetchCalls, 1)
  assert.equal(reauthCalls, 1)
})

test('a 401 with no replacement token is terminal after one attempt', async () => {
  const h = harness(['stale', null], [401])

  await assert.rejects(() => authorizedFetch(URL, h.deps), ReauthRequiredError)
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.removed, ['stale'])
  assert.equal(h.reauthCalls, 1)
})

test('non-401 failures are returned untouched, not retried', async () => {
  const h = harness(['token-a', 'token-b'], [500])
  const response = await authorizedFetch(URL, h.deps)

  assert.equal(response.status, 500)
  assert.equal(h.sent.length, 1, '5xx is not an auth problem')
  assert.deepEqual(h.removed, [])
  assert.equal(h.reauthCalls, 0)
})
