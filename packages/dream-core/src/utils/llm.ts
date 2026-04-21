import type { LLMConfig } from '../types/index.js'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface LLMResponse {
  content: string
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Unified LLM client that works with:
 * - OpenAI (gpt-4o, gpt-4o-mini)
 * - Anthropic (claude-3-5-sonnet, claude-3-haiku)
 * - Local models via Ollama (llama3, mistral, etc.)
 * - Any OpenAI-compatible API
 *
 * dream uses a two-model pattern:
 *   - Main model: heavy consolidation work
 *   - Scoring model: lightweight relevance filtering (cheaper/faster)
 */
export class LLMClient {
  private readonly config: LLMConfig

  constructor(config: LLMConfig) {
    this.config = config
  }

  private getBaseURL(): string {
    if (this.config.baseURL) return this.config.baseURL

    if (this.config.provider === 'anthropic') {
      return 'https://api.anthropic.com/v1'
    }

    return 'https://api.openai.com/v1'
  }

  private getApiKey(): string {
    if (this.config.apiKey) return this.config.apiKey

    if (this.config.provider === 'anthropic') {
      const key = process.env.ANTHROPIC_API_KEY
      if (key) return key
    }

    const key = process.env.OPENAI_API_KEY
    if (key) return key

    throw new Error(
      'No API key found. Set apiKey in config or OPENAI_API_KEY/ANTHROPIC_API_KEY environment variable.',
    )
  }

  /**
   * Call the main model for consolidation work.
   */
  async complete(
    messages: ChatMessage[],
    options?: { model?: string; maxTokens?: number },
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.config.model
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096

    return this.callAPI(messages, model, maxTokens)
  }

  /**
   * Call the scoring model for lightweight relevance filtering.
   * Falls back to the main model if no scoring model is configured.
   */
  async score(messages: ChatMessage[]): Promise<LLMResponse> {
    const model = this.config.scoringModel ?? this.config.model
    return this.callAPI(messages, model, 1024)
  }

  private async callAPI(
    messages: ChatMessage[],
    model: string,
    maxTokens: number,
  ): Promise<LLMResponse> {
    const baseURL = this.getBaseURL()
    const apiKey = this.getApiKey()

    // Detect if this is an Anthropic native API call
    const isAnthropic =
      this.config.provider === 'anthropic' ||
      baseURL.includes('anthropic.com')

    const fn = isAnthropic
      ? () => this.callAnthropicAPI(messages, model, maxTokens, baseURL, apiKey)
      : () =>
          this.callOpenAICompatibleAPI(
            messages,
            model,
            maxTokens,
            baseURL,
            apiKey,
          )

    return this.withRetry(fn)
  }

  /**
   * Retry wrapper with exponential backoff + jitter.
   *
   * Retries on: network errors, 408 timeout, 429 rate-limit,
   * 500/502/503/504 upstream errors. Does NOT retry on: 400/401/403/404
   * (these are deterministic failures — retry will not help).
   *
   * Default: 3 retries, 500ms base delay, caps at ~8s total wait.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
  ): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        const retryableStatus = /\b(408|429|500|502|503|504)\b/.test(msg)
        const networkErr =
          /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed)/i.test(msg)
        const retryable = retryableStatus || networkErr
        if (!retryable || attempt === maxRetries) break
        const base = 500 * Math.pow(2, attempt)
        const jitter = Math.random() * 250
        await new Promise((r) => setTimeout(r, base + jitter))
      }
    }
    throw lastErr
  }

  private async callOpenAICompatibleAPI(
    messages: ChatMessage[],
    model: string,
    maxTokens: number,
    baseURL: string,
    apiKey: string,
  ): Promise<LLMResponse> {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`LLM API error (${response.status}): ${error}`)
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
      usage?: { prompt_tokens: number; completion_tokens: number }
    }

    return {
      content: data.choices[0]?.message?.content ?? '',
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
          }
        : undefined,
    }
  }

  private async callAnthropicAPI(
    messages: ChatMessage[],
    model: string,
    maxTokens: number,
    baseURL: string,
    apiKey: string,
  ): Promise<LLMResponse> {
    // Separate system message from conversation messages
    const systemMessages = messages.filter((m) => m.role === 'system')
    const conversationMessages = messages.filter((m) => m.role !== 'system')

    const response = await fetch(`${baseURL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemMessages.map((m) => m.content).join('\n'),
        messages: conversationMessages,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Anthropic API error (${response.status}): ${error}`)
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>
      usage?: { input_tokens: number; output_tokens: number }
    }

    const textContent = data.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')

    return {
      content: textContent,
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
          }
        : undefined,
    }
  }
}
