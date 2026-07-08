import {
  makeCommandActionFilter,
  makeLinkStripper,
  makeProtocolFilter,
  type SearchIntent,
  type UrlCard
} from '../../packages/core/llm'
import type { CocreateProvider } from './cocreate-types'
import type { CommandChatAction } from './command-chat-types'

export type LocalRuntime = Extract<CocreateProvider, 'codex' | 'claude-code' | 'cursor'>

type LocalAiBridge = {
  status: (req: { runtime: LocalRuntime; command?: string; model?: string }) => Promise<{ ok: boolean; error?: string; version?: string }>
  setup: (req: { runtime: LocalRuntime; command?: string }) => Promise<{ ok: boolean; message?: string; url?: string; code?: string; error?: string }>
  run: (req: { runtime: LocalRuntime; command?: string; model?: string; system: string; userText: string }) => Promise<{ text?: string; error?: string }>
}

function localBridge(): LocalAiBridge | undefined {
  return (globalThis as unknown as { localAi?: LocalAiBridge }).localAi
}

export async function checkLocalRuntime(req: {
  runtime: LocalRuntime
  command?: string
  model?: string
}, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; error?: string; version?: string }> {
  const bridge = localBridge()
  if (bridge) return bridge.status(req)
  try {
    return await postLocalJson('/api/local-ai/status', req, fetchImpl)
  } catch (e) {
    if (shouldTryDevBridge()) {
      try {
        return await postLocalJson('http://127.0.0.1:5173/api/local-ai/status', req, fetchImpl)
      } catch (fallbackError) {
        return { ok: false, error: localBridgeError(fallbackError) }
      }
    }
    return { ok: false, error: localBridgeError(e) }
  }
}

export async function setupLocalRuntime(req: {
  runtime: LocalRuntime
  command?: string
}, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message?: string; url?: string; code?: string; error?: string }> {
  const bridge = localBridge()
  if (bridge) return bridge.setup(req)
  try {
    return await postLocalJson('/api/local-ai/setup', req, fetchImpl)
  } catch (e) {
    if (shouldTryDevBridge()) {
      try {
        return await postLocalJson('http://127.0.0.1:5173/api/local-ai/setup', req, fetchImpl)
      } catch (fallbackError) {
        return { ok: false, error: localBridgeError(fallbackError) }
      }
    }
    return { ok: false, error: localBridgeError(e) }
  }
}

export async function runLocalCocreate(
  req: {
    runtime: LocalRuntime
    command?: string
    model?: string
    system: string
    userText: string
  },
  handlers: {
    onText: (text: string) => void
    onDiagnosis?: (text: string) => void
    onAnchor?: (line: number) => void
    onUrl?: (u: UrlCard) => void
    onInlineImage?: (im: { title: string; url: string; line: number }) => void
  },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ searchIntent?: SearchIntent; passed: boolean; contentLines: number; model?: string; error?: string }> {
  try {
    const text = await runLocalText(req, fetchImpl, signal)
    const strip = makeLinkStripper(
      (t) => handlers.onText(t),
      (u) => handlers.onUrl?.(u),
      (im) => handlers.onInlineImage?.({ ...im, line: Math.max(0, proto.contentLines - 1) })
    )
    const proto = makeProtocolFilter(
      (l) => strip.push(l),
      (d) => handlers.onDiagnosis?.(d),
      (a) => handlers.onAnchor?.(a)
    )
    proto.push(text)
    proto.flush()
    strip.flush()
    return { passed: proto.passed, contentLines: proto.contentLines, model: req.model }
  } catch (e: any) {
    return { passed: false, contentLines: 0, error: e?.message || String(e) }
  }
}

export async function runLocalCommandChat(
  req: {
    runtime: LocalRuntime
    command?: string
    model?: string
    system: string
    userText: string
  },
  handlers: {
    onText: (text: string) => void
    onAction?: (raw: string) => void
  },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ model?: string; error?: string; aborted?: boolean }> {
  const filter = makeCommandActionFilter((t) => handlers.onText(t), (raw) => handlers.onAction?.(raw))
  try {
    const text = await runLocalText(req, fetchImpl, signal)
    filter.push(text)
    filter.flush()
    return { model: req.model }
  } catch (e: any) {
    filter.flush()
    if (e?.name === 'AbortError' || signal?.aborted) return { aborted: true }
    return { error: e?.message || String(e) }
  }
}

async function runLocalText(
  req: {
    runtime: LocalRuntime
    command?: string
    model?: string
    system: string
    userText: string
  },
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<string> {
  const bridge = localBridge()
  if (bridge) {
    const body = await bridge.run(req)
    if (body?.error) throw new Error(body.error)
    return String(body?.text || '')
  }
  try {
    const body = await postLocalJson('/api/local-ai/run', req, fetchImpl, signal)
    return String(body?.text || '')
  } catch (e) {
    if (shouldTryDevBridge()) {
      try {
        const body = await postLocalJson('http://127.0.0.1:5173/api/local-ai/run', req, fetchImpl, signal)
        return String(body?.text || '')
      } catch (fallbackError) {
        throw new Error(localBridgeError(fallbackError))
      }
    }
    throw new Error(localBridgeError(e))
  }
}

async function postLocalJson(
  url: string,
  req: unknown,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<any> {
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok || body?.error) throw new Error(body?.error || `Local runtime failed (${r.status})`)
  return body
}

function shouldTryDevBridge(): boolean {
  if (typeof location === 'undefined') return false
  return location.origin !== 'http://127.0.0.1:5173' && location.origin !== 'http://localhost:5173'
}

function localBridgeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/failed to fetch|load failed|networkerror/i.test(msg)) {
    return 'Local AI bridge is not reachable. This is not the Go backend; local Codex/Claude/Cursor setup requires the desktop app bridge or the Vite dev bridge. Run `npm run dev` and open http://127.0.0.1:5173, or use the Electron desktop app.'
  }
  return msg
}

export function parseLocalAction(raw: string): CommandChatAction | null {
  try {
    return JSON.parse(raw) as CommandChatAction
  } catch {
    return null
  }
}
