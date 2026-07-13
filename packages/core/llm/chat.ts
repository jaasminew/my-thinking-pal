// Client-direct NON-streaming chat completion, for the "parse the whole reply"
// passes (extract-signals, organize, section-header). Returns the raw assistant
// content string; parsing lives in parse.ts. `fetch` is injectable for tests.

import type { FetchLike, LlmProvider, ReasoningParams } from './types'

export interface ChatOptions {
  system: string
  userText: string
  /** Data-URL images attached to the user message (vision-capable providers). */
  images?: string[]
  fetchImpl?: FetchLike
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  reasoning?: ReasoningParams
}

export interface ChatResult {
  content: string
  serverMs: number
  /** Provider completion metadata retained for diagnosing empty/truncated replies. */
  finishReason?: string
  hasReasoningContent: boolean
}

// One request/response round-trip. Throws on transport/HTTP error so callers can
// map failures to their own contract (skip/retry/empty).
export async function chatCompletion(provider: LlmProvider, opts: ChatOptions): Promise<ChatResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const t0 = now()
  const r = await doFetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      ...(provider.requestHeaders || {})
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 3000,
      ...(opts.reasoning ?? {}),
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: userContent(opts.userText, opts.images) }
      ]
    }),
    signal: opts.signal
  })

  const serverMs = Math.round(now() - t0)
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    // The browser's generic "400 (Bad Request)" line hides the useful provider
    // response. Log only safe request identity + response details: never the
    // Authorization header, prompt, or full request body.
    console.warn('[llm] chat completion rejected', {
      status: r.status,
      provider: provider.id,
      model: provider.model,
      endpoint: `${provider.baseUrl}/chat/completions`,
      response: readableErrorBody(body)
    })
    throw new ChatHttpError(r.status, body.slice(0, 300), serverMs)
  }
  const data: any = await r.json()
  const choice = data?.choices?.[0]
  const message = choice?.message
  const content = message?.content || ''
  return {
    content,
    serverMs,
    ...(typeof choice?.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
    hasReasoningContent:
      typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0
  }
}

function readableErrorBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return body.slice(0, 300)
  }
}

export class ChatHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly serverMs: number
  ) {
    super(`LLM ${status}: ${body}`)
    this.name = 'ChatHttpError'
  }
}

function now(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
}

/**
 * OpenAI-compatible user content: a plain string normally, a multimodal parts
 * array when images ride along. Exported for stream.ts (same wire shape).
 */
export function userContent(
  text: string,
  images?: string[]
): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
  if (!images?.length) return text
  return [
    { type: 'text', text },
    ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
  ]
}
