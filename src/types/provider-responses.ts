/** Minimal response shapes read from the supported LLM APIs. */
export interface AnthropicResponse {
  content?: { type: string; name?: string; input?: unknown; text?: string }[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface OpenAiResponse {
  choices?: {
    message?: { content?: string | null; refusal?: string | null }
    finish_reason?: string
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    finishReason?: string
  }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}
