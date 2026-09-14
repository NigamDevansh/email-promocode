import { LlmError, type ProviderAdapter } from '../types/llm.js'
import { asLlmError, errorForResponse, parseJsonPayload } from './http.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    finishReason?: string
  }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

/**
 * §3: the MVP deliberately uses the stateless `generateContent` API rather than
 * Interactions — chat state is stored locally and sent per turn, so server-side
 * interaction state buys nothing, and generateContent has a stable documented
 * structured-output contract.
 */
export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',

  async complete(request, context) {
    const url = `${BASE}/${encodeURIComponent(context.model)}:generateContent`

    let response: Response
    try {
      response = await context.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': context.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: request.schema,
            maxOutputTokens: request.maxTokens,
          },
        }),
      })
    } catch (error) {
      throw asLlmError('gemini', error)
    }

    if (!response.ok) throw await errorForResponse('gemini', response)

    const payload = (await response.json().catch(() => null)) as GeminiResponse | null
    if (!payload) throw new LlmError('schema', 'gemini returned a non-JSON body')

    const usage = {
      inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
    }

    if (payload.promptFeedback?.blockReason) {
      throw new LlmError('refusal', `gemini blocked the prompt: ${payload.promptFeedback.blockReason}`)
    }

    const candidate = payload.candidates?.[0]
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new LlmError('schema', 'gemini hit maxOutputTokens before finishing the JSON')
    }
    if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'RECITATION') {
      throw new LlmError('refusal', `gemini stopped: ${candidate.finishReason}`)
    }

    // A reply can arrive split across several text parts.
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')

    if (!text) throw new LlmError('schema', 'gemini returned no text parts')

    return { json: parseJsonPayload('gemini', text), usage }
  },
}
