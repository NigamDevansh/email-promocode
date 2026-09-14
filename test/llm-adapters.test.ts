import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { adapterFor } from '../src/llm/index.ts'
import { EXTRACTION_SCHEMA, EXTRACTION_SCHEMA_NAME } from '../src/llm/extraction.ts'
import { retryAfterMs } from '../src/llm/http.ts'
import { LlmError, type ProviderContext, type ProviderId } from '../src/types/llm.ts'

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/providers')

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(fixtureDir, `${name}.json`), 'utf8'))

interface Capture {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

test('OpenAI rate-limit delay uses the slower request or token reset', () => {
  const headers = new Headers({
    'retry-after': '1',
    'x-ratelimit-reset-requests': '2s',
    'x-ratelimit-reset-tokens': '1m30s',
  })

  assert.equal(retryAfterMs(headers, 0), 90_000)
})

test('Anthropic rate-limit delay uses the slowest token or request reset', () => {
  const now = Date.parse('2026-09-14T00:00:00Z')
  const headers = new Headers({
    'anthropic-ratelimit-requests-reset': '2026-09-14T00:00:02Z',
    'anthropic-ratelimit-input-tokens-reset': '2026-09-14T00:00:45Z',
    'anthropic-ratelimit-output-tokens-reset': '2026-09-14T00:00:10Z',
  })

  assert.equal(retryAfterMs(headers, now), 45_000)
})

function contextFor(
  body: unknown,
  init: ResponseInit = { status: 200 },
  capture?: Capture[],
): ProviderContext {
  return {
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl: async (url, options) => {
      capture?.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(options?.headers).entries()),
        body: JSON.parse(String(options?.body)) as Record<string, unknown>,
      })
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
    },
  }
}

const request = {
  system: 'system prompt',
  user: 'user prompt',
  schema: EXTRACTION_SCHEMA,
  schemaName: EXTRACTION_SCHEMA_NAME,
  maxTokens: 800,
}

const EXPECTED_OFFER = {
  code: 'SAVE20',
  discount: '20%',
  currency: null,
  min_spend: 2000,
  max_discount: 500,
  expiry: '2026-09-30',
  single_use: null,
  new_users_only: false,
  app_only: true,
  categories: ['fashion'],
  conditions: 'Not valid on sale items',
}

for (const provider of ['anthropic', 'openai', 'gemini'] as ProviderId[]) {
  test(`${provider}: a success response yields the same parsed JSON`, async () => {
    const result = await adapterFor(provider).complete(
      request,
      contextFor(fixture(`${provider}-success`)),
    )

    assert.deepEqual(result.json, { offers: [EXPECTED_OFFER] })
  })

  test(`${provider}: usage is normalised to the same field names`, async () => {
    const { usage } = await adapterFor(provider).complete(
      request,
      contextFor(fixture(`${provider}-success`)),
    )

    assert.ok(usage.inputTokens > 2000, 'input tokens read from the provider-specific field')
    assert.ok(usage.outputTokens > 100, 'output tokens read from the provider-specific field')
  })

  test(`${provider}: 401 is an auth error and is never retried`, async () => {
    await assert.rejects(
      () => adapterFor(provider).complete(request, contextFor({ error: 'bad key' }, { status: 401 })),
      (error: LlmError) => {
        assert.equal(error.kind, 'auth')
        assert.equal(error.retryable, false)
        return true
      },
    )
  })

  test(`${provider}: 500 is retryable`, async () => {
    await assert.rejects(
      () => adapterFor(provider).complete(request, contextFor({ error: 'oops' }, { status: 500 })),
      (error: LlmError) => {
        assert.equal(error.kind, 'server')
        assert.equal(error.retryable, true)
        return true
      },
    )
  })

  test(`${provider}: 408 is retryable`, async () => {
    await assert.rejects(
      () => adapterFor(provider).complete(request, contextFor({ error: 'timeout' }, { status: 408 })),
      (error: LlmError) => {
        assert.equal(error.retryable, true)
        return true
      },
    )
  })

  test(`${provider}: 429 carries the Retry-After delay`, async () => {
    await assert.rejects(
      () =>
        adapterFor(provider).complete(
          request,
          contextFor({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '12' } }),
        ),
      (error: LlmError) => {
        assert.equal(error.kind, 'rate-limit')
        assert.equal(error.retryable, true)
        assert.equal(error.retryAfterMs, 12_000)
        return true
      },
    )
  })

  test(`${provider}: a network failure is retryable, not a schema error`, async () => {
    await assert.rejects(
      () =>
        adapterFor(provider).complete(request, {
          apiKey: 'k',
          model: 'm',
          fetchImpl: async () => {
            throw new TypeError('Failed to fetch')
          },
        }),
      (error: LlmError) => {
        assert.equal(error.kind, 'network')
        assert.equal(error.retryable, true)
        return true
      },
    )
  })
}

test('anthropic sends the browser-access header and forces the tool', async () => {
  const capture: Capture[] = []
  await adapterFor('anthropic').complete(
    request,
    contextFor(fixture('anthropic-success'), { status: 200 }, capture),
  )

  const [call] = capture
  assert.equal(call?.headers['x-api-key'], 'test-key')
  assert.equal(call?.headers['anthropic-version'], '2023-06-01')
  assert.equal(call?.headers['anthropic-dangerous-direct-browser-access'], 'true')
  assert.deepEqual(call?.body['tool_choice'], { type: 'tool', name: EXTRACTION_SCHEMA_NAME })
  assert.equal(call?.body['system'], 'system prompt')
})

test('openai sends a strict json_schema response format', async () => {
  const capture: Capture[] = []
  await adapterFor('openai').complete(
    request,
    contextFor(fixture('openai-success'), { status: 200 }, capture),
  )

  const [call] = capture
  assert.equal(call?.headers['authorization'], 'Bearer test-key')
  const format = call?.body['response_format'] as { json_schema?: { strict?: boolean } }
  assert.equal(format?.json_schema?.strict, true)
  assert.ok(call?.body['max_completion_tokens'], 'uses max_completion_tokens, not max_tokens')
})

test('a 400 invalid-model response is classified as a model error', async () => {
  await assert.rejects(
    () =>
      adapterFor('openai').complete(
        request,
        contextFor(
          { error: { message: 'The requested model does not exist' } },
          { status: 400 },
        ),
      ),
    (error: LlmError) => {
      assert.equal(error.kind, 'model')
      assert.equal(error.retryable, false)
      return true
    },
  )
})

test('gemini puts the model in the path and the key in a header', async () => {
  const capture: Capture[] = []
  await adapterFor('gemini').complete(
    request,
    contextFor(fixture('gemini-success'), { status: 200 }, capture),
  )

  const [call] = capture
  assert.match(call?.url ?? '', /\/models\/test-model:generateContent$/)
  assert.equal(call?.headers['x-goog-api-key'], 'test-key')
  assert.ok(!(call?.url ?? '').includes('test-key'), 'the key never goes in the URL')
})

test('anthropic reports a missing tool call as a refusal, not malformed JSON', async () => {
  await assert.rejects(
    () => adapterFor('anthropic').complete(request, contextFor(fixture('anthropic-refusal'))),
    (error: LlmError) => {
      assert.equal(error.kind, 'refusal')
      assert.equal(error.retryable, false)
      return true
    },
  )
})

test('openai surfaces an explicit refusal', async () => {
  await assert.rejects(
    () => adapterFor('openai').complete(request, contextFor(fixture('openai-refusal'))),
    (error: LlmError) => {
      assert.equal(error.kind, 'refusal')
      return true
    },
  )
})

test('openai names truncation rather than blaming the JSON', async () => {
  await assert.rejects(
    () => adapterFor('openai').complete(request, contextFor(fixture('openai-truncated'))),
    (error: LlmError) => {
      assert.equal(error.kind, 'schema')
      assert.match(error.message, /max_completion_tokens/)
      return true
    },
  )
})

test('gemini surfaces a blocked prompt', async () => {
  await assert.rejects(
    () => adapterFor('gemini').complete(request, contextFor(fixture('gemini-blocked'))),
    (error: LlmError) => {
      assert.equal(error.kind, 'refusal')
      return true
    },
  )
})

test('gemini reports prose where JSON was required as a schema error', async () => {
  await assert.rejects(
    () => adapterFor('gemini').complete(request, contextFor(fixture('gemini-malformed'))),
    (error: LlmError) => {
      assert.equal(error.kind, 'schema')
      assert.equal(error.retryable, false)
      return true
    },
  )
})

test('gemini joins a reply split across several text parts', async () => {
  // The success fixture deliberately splits the JSON mid-token across two parts.
  const result = await adapterFor('gemini').complete(request, contextFor(fixture('gemini-success')))
  assert.deepEqual(result.json, { offers: [EXPECTED_OFFER] })
})
