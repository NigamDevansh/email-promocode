import assert from 'node:assert/strict'
import test from 'node:test'
import { createGmailPort, GmailApiError } from '../src/background/gmail.ts'
import type { AuthorizedFetchDeps } from '../src/types/auth.ts'

function depsReturning(response: () => Response): AuthorizedFetchDeps {
  return {
    tokens: {
      async get() {
        return 'token'
      },
      async remove() {},
    },
    async fetchImpl() {
      return response()
    },
    async onReauthRequired() {},
  }
}

test('preserves Gmail structured error reasons for retry decisions', async () => {
  const deps = depsReturning(
    () =>
      new Response(JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), {
        status: 403,
      }),
  )

  await assert.rejects(
    () => createGmailPort(deps).listPage({ newerThanDays: 45, pageToken: null, pageSize: 50 }),
    (error: unknown) =>
      error instanceof GmailApiError && error.reason === 'userRateLimitExceeded',
  )
})

test('a page listing asks for the Promotions label and the configured window', async () => {
  const requested: string[] = []
  const deps: AuthorizedFetchDeps = {
    tokens: {
      async get() {
        return 'token'
      },
      async remove() {},
    },
    async fetchImpl(url) {
      requested.push(String(url))
      return new Response(JSON.stringify({ messages: [{ id: 'a' }], nextPageToken: 'next' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
    async onReauthRequired() {},
  }

  const page = await createGmailPort(deps).listPage({
    newerThanDays: 45,
    pageToken: null,
    pageSize: 50,
  })

  assert.deepEqual(page, { ids: ['a'], nextPageToken: 'next' })
  assert.match(requested[0] ?? '', /labelIds=CATEGORY_PROMOTIONS/)
  assert.match(requested[0] ?? '', /newer_than%3A45d/)
})
