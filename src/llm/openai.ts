import { LlmError, type ProviderAdapter } from '../types/llm.js'
import type { OpenAiResponse } from '../types/provider-responses.js'
import { asLlmError, errorForResponse, parseJsonPayload } from './http.js'

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',

  async complete(request, context) {
    let response: Response
    try {
      response = await context.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${context.apiKey}`,
        },
        body: JSON.stringify({
          model: context.model,
          max_completion_tokens: request.maxTokens,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: request.schemaName, schema: request.schema, strict: true },
          },
        }),
      })
    } catch (error) {
      throw asLlmError('openai', error)
    }

    if (!response.ok) throw await errorForResponse('openai', response)

    const payload = (await response.json().catch(() => null)) as OpenAiResponse | null
    if (!payload) throw new LlmError('schema', 'openai returned a non-JSON body')

    const choice = payload.choices?.[0]
    const usage = {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
    }

    if (choice?.message?.refusal) {
      throw new LlmError('refusal', `openai refused: ${choice.message.refusal.slice(0, 200)}`)
    }
    if (choice?.finish_reason === 'length') {
      throw new LlmError('schema', 'openai hit max_completion_tokens before finishing the JSON')
    }

    const content = choice?.message?.content
    if (!content) throw new LlmError('schema', 'openai returned no message content')

    return { json: parseJsonPayload('openai', content), usage }
  },
}
