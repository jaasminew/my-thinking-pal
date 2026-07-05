import { spawn } from 'node:child_process'
import path from 'node:path'

// Spawn the local coding-agent CLIs in HEADLESS mode so the canvas can route
// co-creation through your *subscription* (Claude / ChatGPT) instead of a paid
// per-token API key. The browser never sees any of this — it only calls
// /api/cocreate, which calls these.
//
// One-time setup each requires (interactive, you do it once):
//   claude → `claude setup-token`  → paste the token into .env as CLAUDE_CODE_OAUTH_TOKEN
//   codex  → `./node_modules/.bin/codex login`  (ChatGPT auth, stored in ~/.codex)

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'url'; title: string; url: string; snippet?: string; image?: string }

// CN: the CLIs hit api.anthropic.com / api.openai.com, which need the local
// proxy. Node's spawn doesn't read a shell alias, so we inject it explicitly.
function proxyEnv(): Record<string, string> {
  const p =
    process.env.AGENT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    ''
  if (!p) return {}
  return { http_proxy: p, https_proxy: p, HTTP_PROXY: p, HTTPS_PROXY: p }
}

// Recursively pull {url,title} pairs out of any parsed JSON node — robust to the
// exact stream-json / JSONL shape, which differs across CLI versions and tools.
function harvestUrls(node: any, out: AgentEvent[], seen: Set<string>): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const v of node) harvestUrls(v, out, seen)
    return
  }
  const url = node.url
  const title = node.title || node.page_title || node.name
  if (typeof url === 'string' && /^https?:\/\//.test(url) && !seen.has(url)) {
    seen.add(url)
    out.push({
      type: 'url',
      url,
      title: typeof title === 'string' && title ? title : url,
      snippet:
        typeof node.snippet === 'string'
          ? node.snippet
          : typeof node.description === 'string'
            ? node.description
            : undefined
    })
  }
  for (const k of Object.keys(node)) harvestUrls(node[k], out, seen)
}

/**
 * Claude Code headless. Streams text deltas and, when webSearch is on, harvests
 * inspiration URLs from the built-in WebSearch tool results.
 */
export async function* runClaude(opts: {
  prompt: string
  system: string
  webSearch: boolean
}): AsyncGenerator<AgentEvent> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (!token) {
    throw new Error(
      'CLAUDE_CODE_OAUTH_TOKEN missing — run `claude setup-token` and add it to .env'
    )
  }

  const args = [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--append-system-prompt',
    opts.system
  ]
  if (opts.webSearch) {
    args.push('--allowedTools', 'WebSearch', '--permission-mode', 'bypassPermissions')
  }

  const child = spawn('claude', args, {
    env: {
      ...process.env,
      ...proxyEnv(),
      CLAUDE_CODE_OAUTH_TOKEN: token,
      // Force subscription auth: a stray empty API key makes the CLI 401.
      ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  yield* parseNdjson(child, (obj, out, seen) => {
    // Token deltas (partial messages).
    const delta = obj?.event?.delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      out.push({ type: 'text', text: delta.text })
    }
    // Web search results live somewhere in the tree — harvest them.
    if (opts.webSearch) harvestUrls(obj, out, seen)
  })
}

/**
 * Codex (ChatGPT) headless via `codex exec --json`. Streams assistant text.
 * Structured URL cards aren't reliably exposed by Codex's JSONL yet, so any
 * links it finds arrive inline in the text for now.
 */
export async function* runCodex(opts: {
  prompt: string
  system: string
  webSearch: boolean
}): AsyncGenerator<AgentEvent> {
  const bin = path.resolve(process.cwd(), 'node_modules/.bin/codex')
  const fullPrompt = `${opts.system}\n\n---\n\n${opts.prompt}`
  const args = ['exec', '--json', '--skip-git-repo-check']
  if (opts.webSearch) args.push('-c', 'tools.web_search=true')
  args.push(fullPrompt)

  const child = spawn(bin, args, {
    env: { ...process.env, ...proxyEnv() },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  yield* parseNdjson(child, (obj, out, seen) => {
    // Codex JSONL nests the assistant message under a few possible keys.
    const item = obj?.item || obj?.msg || obj
    const text =
      item?.type === 'agent_message'
        ? item.text || item.message
        : obj?.delta || undefined
    if (typeof text === 'string' && text) out.push({ type: 'text', text })
    if (opts.webSearch) harvestUrls(obj, out, seen)
  })
}

// Shared: read a child's stdout as newline-delimited JSON, run `onObj` per line
// to turn it into AgentEvents, and surface stderr on a non-zero exit.
async function* parseNdjson(
  child: ReturnType<typeof spawn>,
  onObj: (obj: any, out: AgentEvent[], seen: Set<string>) => void
): AsyncGenerator<AgentEvent> {
  const seen = new Set<string>()
  let buf = ''
  let stderr = ''
  child.stderr?.on('data', (d) => (stderr += d.toString()))

  const queue: AgentEvent[] = []
  let resolveWake: (() => void) | null = null
  let exited = false
  let exitErr: Error | null = null

  const wake = () => {
    if (resolveWake) {
      resolveWake()
      resolveWake = null
    }
  }

  child.stdout?.on('data', (chunk) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        onObj(obj, queue, seen)
      } catch {
        // Not JSON (plain-text fallback) — pass it straight through as text.
        queue.push({ type: 'text', text: line + '\n' })
      }
    }
    wake()
  })
  child.on('error', (e) => {
    exitErr = e
    exited = true
    wake()
  })
  child.on('close', (code) => {
    if (buf.trim()) {
      try {
        onObj(JSON.parse(buf.trim()), queue, seen)
      } catch {
        queue.push({ type: 'text', text: buf })
      }
    }
    if (code && code !== 0 && !queue.length) {
      exitErr = new Error(stderr.trim().slice(0, 400) || `agent exited ${code}`)
    }
    exited = true
    wake()
  })

  for (;;) {
    while (queue.length) yield queue.shift()!
    if (exited) break
    await new Promise<void>((r) => (resolveWake = r))
  }
  if (exitErr) throw exitErr
}
