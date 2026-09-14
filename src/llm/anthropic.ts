import { LlmError, type ProviderAdapter } from '../types/llm.js'
import { asLlmError, errorForResponse } from './http.js'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'

interface AnthropicResponse {
  content?: { type: string; name?: string; input?: unknown; text?: string }[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * §3: structured output comes from a tool with an `input_schema`, forced with
 * `tool_choice`, rather than from prompting alone.
 */
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
          // Required for requests made from an extension context.
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
      // A refusal or a stop before the tool call arrives here, not as an error status.
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
