// Client-direct streaming chat completion. Talks straight to an OpenAI-compatible
// provider (Groq/Cerebras/OpenAI/OpenRouter/Ollama) — no backend proxy, no undici
// dispatcher. `fetch` is injectable so tests drive it with a mock SSE stream.

import { getReasoningParams } from './parse'
import { userContent } from './chat'
import type { FetchLike, LlmProvider } from './types'

export interface StreamOptions {
  system: string
  userText: string
  /** Data-URL images attached to the user message (vision-capable providers). */
  images?: string[]
  onText: (t: string) => void
  fetchImpl?: FetchLike
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
}

export interface SearchIntent {
  query: string
  image: boolean
}

// Stream a completion as concise bullet LINES. Emits a completed line at a time
// via onText (so each bullet renders whole), strips Qwen <think>, and intercepts
// a trailing `SEARCH: <q>` / `SEARCH IMAGE: <q>` line — returned, not shown, so
// it can drive web search (image=true → inline bullet image, else a link card).
export async function streamOpenModel(
  provider: LlmProvider,
  opts: StreamOptions
): Promise<SearchIntent | undefined> {
  const doFetch = opts.fetchImpl ?? fetch
  const noThink = /qwen3/i.test(provider.model) ? ' /no_think' : ''
  const r = await doFetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      ...(provider.requestHeaders || {})
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 512,
      stream: true,
      ...getReasoningParams(provider.model),
      messages: [
        { role: 'system', content: opts.system + noThink },
        { role: 'user', content: userContent(opts.userText, opts.images) }
      ]
    }),
    signal: opts.signal
  })

  if (!r.ok || !r.body) {
    throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }

  let searchQuery: SearchIntent | undefined
  let line = '' // current (incomplete) output line

  const emitLine = (l: string) => {
    const m = l.match(/^\s*SEARCH(\s+IMAGE)?\s*:\s*(.+)$/i)
    if (m) {
      searchQuery = { query: m[2].trim(), image: !!m[1] }
      return // capture, don't show
    }
    if (l.trim()) opts.onText(l + '\n')
  }

  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let inThink = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!raw.startsWith('data:')) continue
      const data = raw.slice(5).trim()
      if (data === '[DONE]') {
        if (line) emitLine(line)
        return searchQuery
      }
      try {
        const piece = JSON.parse(data)?.choices?.[0]?.delta?.content
        if (typeof piece !== 'string' || !piece) continue
        // Strip Qwen <think>…</think> that leaks through despite /no_think.
        // Loops so it is correct regardless of chunking: a whole block in one
        // delta, a block split across deltas, or several blocks in one delta.
        let t = piece
        let visible = ''
        while (t.length) {
          if (inThink) {
            const end = t.indexOf('</think>')
            if (end < 0) {
              t = ''
              break
            }
            t = t.slice(end + '</think>'.length)
            inThink = false
          } else {
            const open = t.indexOf('<think>')
            if (open < 0) {
              visible += t
              break
            }
            visible += t.slice(0, open)
            t = t.slice(open + '<think>'.length)
            inThink = true
          }
        }
        line += visible
        let i: number
        while ((i = line.indexOf('\n')) >= 0) {
          emitLine(line.slice(0, i))
          line = line.slice(i + 1)
        }
      } catch {
        /* partial JSON line — ignore */
      }
    }
  }
  if (line) emitLine(line)
  return searchQuery
}
