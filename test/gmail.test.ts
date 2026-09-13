import assert from 'node:assert/strict'
import test from 'node:test'
import { listPromotionSummaries } from '../src/background/gmail.ts'
import type { AuthorizedFetchDeps } from '../src/types/auth.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('lists recent Promotions messages and returns newest summaries first', async () => {
  const detailRequests: URL[] = []
  const deps: AuthorizedFetchDeps = {
    tokens: {
      async get() {
        return 'token'
      },
      async remove() {
        assert.fail('a successful request must not remove the token')
      },
    },
    async fetchImpl(input, init) {
      const url = new URL(String(input))
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer token')

      if (url.pathname.endsWith('/messages')) {
        assert.equal(url.searchParams.get('labelIds'), 'CATEGORY_PROMOTIONS')
        assert.equal(url.searchParams.get('q'), 'newer_than:45d')
        assert.equal(url.searchParams.get('maxResults'), '2')
        return jsonResponse({
          messages: [
            { id: 'older', threadId: 'thread-1' },
            { id: 'newer', threadId: 'thread-2' },
          ],
        })
      }

      detailRequests.push(url)
      const id = url.pathname.split('/').at(-1)
      assert.equal(url.searchParams.get('format'), 'metadata')
      assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['Subject', 'From'])

      return jsonResponse({
        id,
        threadId: id === 'newer' ? 'thread-2' : 'thread-1',
        internalDate: id === 'newer' ? '200' : '100',
        payload: {
          headers: [
            { name: 'Subject', value: id === 'newer' ? 'New offer' : 'Old offer' },
            { name: 'From', value: 'Store <offers@example.com>' },
          ],
        },
      })
    },
    async onReauthRequired() {
      assert.fail('a successful request must not require reauthentication')
    },
  }

  const summaries = await listPromotionSummaries(deps, 2)

  assert.equal(detailRequests.length, 2)
  assert.deepEqual(
    summaries.map(({ id, subject, date }) => ({ id, subject, date })),
    [
      { id: 'newer', subject: 'New offer', date: 200 },
      { id: 'older', subject: 'Old offer', date: 100 },
    ],
  )
})
