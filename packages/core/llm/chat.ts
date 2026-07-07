// Client-direct NON-streaming chat completion, for the "parse the whole reply"
// passes (extract-signals, organize, section-header). Returns the raw assistant
// content string; parsing lives in parse.ts. `fetch` is injectable for tests.

import type { FetchLike, LlmProvider, ReasoningParams } from './types'

export interface ChatOptions {
  system: string
  userText: string
  fetchImpl?: FetchLike
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  reasoning?: ReasoningParams
}

export interface ChatResult {
  content: string
  serverMs: number
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
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 3000,
      ...(opts.reasoning ?? {}),
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.userText }
      ]
    }),
    signal: opts.signal
  })

  const serverMs = Math.round(now() - t0)
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new ChatHttpError(r.status, body.slice(0, 300), serverMs)
  }
  const data: any = await r.json()
  const content = data?.choices?.[0]?.message?.content || ''
  return { content, serverMs }
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
