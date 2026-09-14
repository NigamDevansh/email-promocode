import { LlmError, type ProviderAdapter } from '../types/llm.js'
import type { AnthropicResponse } from '../types/provider-responses.js'
import { asLlmError, errorForResponse } from './http.js'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',

  async complete(request, context) {
    let response: Response
    try {
      response = await context.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': context.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: context.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          tools: [
            {
              name: request.schemaName,
              description: 'Record the structured result.',
              input_schema: request.schema,
            },
          ],
          tool_choice: { type: 'tool', name: request.schemaName },
        }),
      })
    } catch (error) {
      throw asLlmError('anthropic', error)
    }

    if (!response.ok) throw await errorForResponse('anthropic', response)

    const payload = (await response.json().catch(() => null)) as AnthropicResponse | null
    if (!payload) throw new LlmError('schema', 'anthropic returned a non-JSON body')

    const toolUse = payload.content?.find(
      (block) => block.type === 'tool_use' && block.name === request.schemaName,
    )

    if (!toolUse || toolUse.input === undefined) {
      const text = payload.content?.find((block) => block.type === 'text')?.text ?? ''
      throw new LlmError(
        'refusal',
        `anthropic returned no ${request.schemaName} tool call` +
          (payload.stop_reason ? ` (stop_reason: ${payload.stop_reason})` : '') +
          (text ? `: ${text.slice(0, 200)}` : ''),
      )
    }

    return {
      json: toolUse.input,
      usage: {
        inputTokens: payload.usage?.input_tokens ?? 0,
        outputTokens: payload.usage?.output_tokens ?? 0,
      },
    }
  },
}
