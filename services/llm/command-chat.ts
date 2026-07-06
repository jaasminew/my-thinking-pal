import type {
  CommandChatRequest,
  CommandChatResult,
  CommandChatEvent,
  CommandChatAction
} from './command-chat-types'

export interface CommandChatHandlers {
  /** Streamed chat text delta — append to the live assistant message. */
  onText: (text: string) => void
  /** A proposed canvas action — render as a button, never auto-apply. */
  onAction?: (action: CommandChatAction) => void
}

// Tier-3 command-chat client. Same NDJSON transport as requestCocreate: the
// server holds all keys and routes claude-code / codex / open. Stateless —
// the caller sends the full history + fresh context every turn.
export async function requestCommandChat(
  req: CommandChatRequest,
  handlers: CommandChatHandlers,
  signal?: AbortSignal
): Promise<CommandChatResult> {
  try {
    const r = await fetch('/api/command-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal
    })

    if (!r.ok || !r.body) {
      let msg = `command-chat ${r.status}`
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
    let model: string | undefined
    let provider = req.provider
    let error: string | undefined

    const handle = (line: string) => {
      if (!line.trim()) return
      let ev: CommandChatEvent
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type === 'text') handlers.onText(ev.text)
      else if (ev.type === 'action') handlers.onAction?.(ev.action)
      else if (ev.type === 'done') {
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

    return { model, provider, error }
  } catch (e: any) {
    if (e?.name === 'AbortError' || signal?.aborted) return { aborted: true }
    return { error: e?.message || String(e) }
  }
}
