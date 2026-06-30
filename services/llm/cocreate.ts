import type {
  CocreateRequest,
  CocreateResult,
  CocreateEvent,
  UrlCard
} from './cocreate-types'

export interface CocreateHandlers {
  /** Called for every streamed text delta (render it live on the canvas). */
  onText: (text: string) => void
  /** Called once when web-search inspiration URLs arrive. */
  onUrls?: (urls: UrlCard[]) => void
}

// Reusable Tier-2 / Tier-3 client. Streams the model's adjacent content back
// line-by-line (NDJSON) so the canvas renders it live — co-creation latency is
// felt, so we never wait for the whole response. The server (/api/cocreate)
// holds all keys and routes claude-code / codex / open(+Tavily).
export async function requestCocreate(
  req: CocreateRequest,
  handlers: CocreateHandlers
): Promise<CocreateResult> {
  try {
    const r = await fetch('/api/cocreate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })

    // Pre-stream failures (bad request) come back as JSON, not a stream.
    if (!r.ok || !r.body) {
      let msg = `cocreate ${r.status}`
      try {
        msg = (await r.json())?.error || msg
      } catch {
        /* non-JSON body */
      }
      return { error: msg }
    }

    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const urls: UrlCard[] = []
    let model: string | undefined
    let provider = req.provider
    let error: string | undefined

    const handle = (line: string) => {
      if (!line.trim()) return
      let ev: CocreateEvent
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type === 'text') handlers.onText(ev.text)
      else if (ev.type === 'urls') {
        urls.push(...ev.urls)
        handlers.onUrls?.(ev.urls)
      } else if (ev.type === 'done') {
        model = ev.model
        provider = ev.provider
      } else if (ev.type === 'error') {
        error = ev.error
      }
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    }
    if (buf.trim()) handle(buf)

    return { model, provider, urls, error }
  } catch (e: any) {
    return { error: e?.message || String(e) }
  }
}
