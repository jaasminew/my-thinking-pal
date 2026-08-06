// Test doubles for the client-direct transport. These let unit/integration tests
// exercise the full pipeline with zero network and zero real keys.

import type { FetchLike, LlmProvider } from '../types'

export const TEST_PROVIDER: LlmProvider = {
  id: 'groq',
  label: 'Groq (test)',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'test-key',
  model: 'openai/gpt-oss-20b',
  kind: 'openai-compatible'
}

// Build a Response whose body is an OpenAI-style SSE stream. Each chunk in
// `deltas` becomes one `data: {...}` line; a final `data: [DONE]` is appended.
export function sseResponse(deltas: string[], init?: { status?: number }): Response {
  const status = init?.status ?? 200
  const lines = deltas.map(
    (d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`
  )
  lines.push('data: [DONE]\n\n')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      // Emit as several network chunks so the parser's cross-chunk buffering is
      // genuinely exercised (split each SSE line mid-way).
      for (const l of lines) {
        const mid = Math.floor(l.length / 2)
        controller.enqueue(enc.encode(l.slice(0, mid)))
        controller.enqueue(enc.encode(l.slice(mid)))
      }
      controller.close()
    }
  })
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

// Build a plain JSON chat-completion Response (non-streaming passes).
export function jsonResponse(
  content: string,
  init?: { status?: number; finishReason?: string; reasoningContent?: string }
): Response {
  const status = init?.status ?? 200
  // finish_reason / reasoning_content are optional so a test can reproduce a
  // provider that stopped on `length` having written nothing but reasoning.
  const payload = status >= 400 ? content : JSON.stringify({
    choices: [{
      message: { content, ...(init?.reasoningContent ? { reasoning_content: init.reasoningContent } : {}) },
      ...(init?.finishReason ? { finish_reason: init.finishReason } : {})
    }]
  })
  return new Response(payload, {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

// A fetch stub that returns a queued sequence of Responses (one per call), and
// records the requests it received so tests can assert on URL/body/headers.
export interface MockFetch {
  fetch: FetchLike
  calls: { url: string; init?: RequestInit; body?: any }[]
}

// Raw JSON Response (arbitrary object), for the minimal backend relays
// (/api/search, /api/url-meta) that are NOT chat-completion shaped.
export function rawJsonResponse(obj: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(obj), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

// A fetch stub that routes by URL predicate — robust to call ordering when a
// flow hits multiple endpoints (provider stream + /api/search + /api/url-meta).
export function mockFetchRouter(
  routes: { match: (url: string) => boolean; respond: (url: string, init?: RequestInit) => Response }[]
): MockFetch {
  const calls: MockFetch['calls'] = []
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    let body: any
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined
    } catch {
      body = init?.body
    }
    calls.push({ url, init, body })
    const route = routes.find((r) => r.match(url))
    if (!route) return new Response('no route', { status: 404 })
    return route.respond(url, init)
  }) as unknown as FetchLike
  return { fetch: fetchImpl, calls }
}

export function mockFetchSequence(responses: Response[]): MockFetch {
  const calls: MockFetch['calls'] = []
  let i = 0
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    let body: any
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined
    } catch {
      body = init?.body
    }
    calls.push({ url, init, body })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return r
  }) as unknown as FetchLike
  return { fetch: fetchImpl, calls }
}
