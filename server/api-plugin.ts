import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import crypto from 'node:crypto'
import { getDispatcher } from './proxy'
import { runClaude, runCodex } from './agents'
import { tavilySearch } from './search'
import type { UrlCard } from '../services/llm/cocreate-types'

// ---- Tier-2 co-creation (Unit 2) -------------------------------------------
// Strong model that BUILDS ON the user's thinking — never rewrites it. It gets
// the full transcript + the keyword note's contents as context, REASONS about
// what the user is reaching for, and replies with concise bullets (Figma model).
const COCREATE_SYSTEM =
  `You are an AMBIENT co-creation partner inside a "keyword note" on a thinking canvas. ` +
  `You receive the full transcript, the user's keyword and bullets, and a record of what ` +
  `they KEPT (liked) and REJECTED (disliked) from your earlier suggestions. ` +
  `Add EXACTLY ONE small increment — a SINGLE concise bullet (≤ 14 words), nothing more. ` +
  `Do NOT repeat or restate the user's words or anything already on the canvas; go somewhere NEW. ` +
  `Aim for ONE of: (1) deepen resonance — point to a similar project, real example, or supporting ` +
  `idea; (2) expand possibility — a loosely-relevant, interdisciplinary, or thought-provoking spark. ` +
  `Lean toward what the user KEPT; avoid the directions they REJECTED. ` +
  `Output ONLY the single bullet line starting with "- ". No preamble, no extra lines.`

// ---- Tier-3 command (Unit 2) -----------------------------------------------
// Explicit instruction typed into the command box ("go search some voice-to-text
// products"). Same concise-bullet output; web search supplies inspiration URLs.
const COMMAND_SYSTEM =
  `You are an assistant inside a keyword note on a thinking canvas. The user gives an ` +
  `explicit command, with the transcript and their notes as context. Carry it out and ` +
  `reply with ONE concise bullet (≤ 14 words) starting with "- ". No preamble, no extra lines.`

// Open-model path can't search on its own, so we ask it to name the query it
// would search — that reasoned query drives Tavily (CLIs search natively).
const SEARCH_INSTRUCTION =
  `\n\nIf (and only if) a concrete web example would help the user more than your bullet, ` +
  `add ONE final line exactly: "SEARCH: <one focused query>" for a single inspiration link. ` +
  `Otherwise omit it. Put nothing after it.`

// CLI providers (Claude/Codex) search natively, and the structured results are
// harvested into URL cards automatically. We must (a) force an actual search, yet
// (b) keep the reply to just bullets — no preamble, no Sources list (those leak in
// as bullets). "Search now" forces the tool; "start with the first bullet" trims
// the chatter. (Telling it to be fully "silent" made it skip searching entirely.)
const CLI_SEARCH_INSTRUCTION =
  `\n\nIf a concrete web example would help, use your web search tool NOW to find ONE ` +
  `relevant inspiration link (actually run the search). Reply with ONLY your single ` +
  `bullet: start directly with the "-" bullet, no preamble and no "Sources" list ` +
  `(the link is captured for you automatically).`

// ---- LLM provider registry -------------------------------------------------
// Every provider below speaks the OpenAI-compatible /chat/completions API, so
// one code path covers local Ollama + hosted Groq/Cerebras. This file is the
// only place that knows provider URLs/keys — the browser never sees a key.
type LlmCfg = { base: string; key: string; model: string; proxy: boolean }

const LLM: Record<string, () => LlmCfg> = {
  ollama: () => ({
    base: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    key: 'ollama',
    model: process.env.OLLAMA_MODEL || 'qwen3:1.7b',
    proxy: false
  }),
  groq: () => ({
    base: 'https://api.groq.com/openai/v1',
    key: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    proxy: true
  }),
  cerebras: () => ({
    base: 'https://api.cerebras.ai/v1',
    key: process.env.CEREBRAS_API_KEY || '',
    model: process.env.CEREBRAS_MODEL || 'llama3.1-8b',
    proxy: true
  })
}

export function apiPlugin(): Plugin {
  return {
    name: 'thinking-pal-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''

        // --- POST /api/highlight: text -> phrases to highlight ---
        if (url.startsWith('/api/highlight') && req.method === 'POST') {
          try {
            const { systemPrompt, text, provider, model } = await readBody(req)

            const cfg = (LLM[provider] || LLM.groq)()
            // Client-supplied model id (Groq picker) overrides the .env default.
            if (model) cfg.model = model
            if (cfg.proxy && !cfg.key) {
              return json(res, 400, { error: `${provider} needs an API key in .env`, phrases: [] })
            }

            const reasoningParams = getReasoningParams(cfg.model)
            const sys =
              `${systemPrompt}\n\n` +
              `Return ONLY the exact phrases to highlight, copied verbatim from the text below, ` +
              `one phrase per line. No numbering, no quotes, no commentary. ` +
              `If nothing is worth highlighting, return nothing.`
            const userText = /qwen3/i.test(cfg.model) ? `${text}\n\n/no_think` : text

            const t0 = performance.now()
            const r = await fetch(`${cfg.base}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.key}`
              },
              body: JSON.stringify({
                model: cfg.model,
                temperature: 0.2,
                max_tokens: 200,
                ...reasoningParams,
                messages: [
                  { role: 'system', content: sys },
                  { role: 'user', content: userText }
                ]
              }),
              // Only route hosted providers through the proxy dispatcher.
              ...(cfg.proxy ? { dispatcher: getDispatcher() } : {})
            } as any)

            const serverMs = Math.round(performance.now() - t0)
            if (!r.ok) {
              const body = await r.text()
              return json(res, 502, { error: `LLM ${r.status}: ${body.slice(0, 300)}`, serverMs, phrases: [] })
            }
            const data: any = await r.json()
            const raw = data?.choices?.[0]?.message?.content || ''
            // Drop any Qwen reasoning block that slipped through.
            const content = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
            return json(res, 200, { phrases: parsePhrases(content), serverMs, model: cfg.model })
          } catch (e: any) {
            return json(res, 500, { error: e?.message || String(e), phrases: [] })
          }
        }

        // --- POST /api/clean-transcript: raw STT chunk -> cleaned marked text ---
        if (url.startsWith('/api/clean-transcript') && req.method === 'POST') {
          try {
            const { systemPrompt, rawText, existingNotes, provider, model } = await readBody(req)
            if (!rawText || typeof rawText !== 'string') {
              return json(res, 400, { error: 'rawText is required', markedText: '', serverMs: 0 })
            }

            const cfg = (LLM[provider] || LLM.groq)()
            if (model) cfg.model = model
            if (cfg.proxy && !cfg.key) {
              return json(res, 400, { error: `${provider} needs an API key in .env`, markedText: '' })
            }

            const reasoningParams = getReasoningParams(cfg.model)
            const sys =
              `${systemPrompt}\n\n` +
              `You are maintaining ONE evolving visible note, not appending a mini-summary. ` +
              `Use the existing cleaned notes only as context. Integrate the new raw speech, ` +
              `merge duplicate ideas, remove repeated wording, and delete weak fragments. ` +
              `Output the full updated note as a coherent, compact structure. Prefer 3-6 bullets total. ` +
              `Each bullet should contain one complete idea, not a repeated keyword. ` +
              `Match the user's dominant language. If the new raw speech is mostly Chinese, write Chinese; ` +
              `if mostly English, write English. Preserve code-switching only when it carries meaning. ` +
              `Use ==double equals== sparingly to mark only the most important ideas. ` +
              `Do not explain what you changed. ` +
              `Do not include raw transcript labels, JSON, code fences, or commentary.`
            const userText = /qwen3/i.test(cfg.model)
              ? buildCleanTranscriptUserText(rawText, existingNotes) + '\n\n/no_think'
              : buildCleanTranscriptUserText(rawText, existingNotes)

            const t0 = performance.now()
            const r = await fetch(`${cfg.base}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.key}`
              },
              body: JSON.stringify({
                model: cfg.model,
                temperature: 0.25,
                max_tokens: 700,
                ...reasoningParams,
                messages: [
                  { role: 'system', content: sys },
                  { role: 'user', content: userText }
                ]
              }),
              ...(cfg.proxy ? { dispatcher: getDispatcher() } : {})
            } as any)

            const serverMs = Math.round(performance.now() - t0)
            if (!r.ok) {
              const body = await r.text()
              return json(res, 502, { error: `LLM ${r.status}: ${body.slice(0, 300)}`, serverMs, markedText: '' })
            }
            const data: any = await r.json()
            const raw = data?.choices?.[0]?.message?.content || ''
            const markedText = sanitizeCleanedTranscript(raw)
            if (!markedText) {
              return json(res, 502, {
                error: 'LLM returned reasoning/no visible cleaned transcript; try a non-reasoning model.',
                serverMs,
                markedText: ''
              })
            }
            return json(res, 200, { markedText, serverMs, model: cfg.model })
          } catch (e: any) {
            return json(res, 500, { error: e?.message || String(e), markedText: '', serverMs: 0 })
          }
        }

        // --- POST /api/cocreate: rough idea / command -> streamed NDJSON ---
        // Tier-2 build-on (or Tier-3 command). Three switchable backends, all
        // streamed line-by-line so the canvas renders live. Web search (when on)
        // returns inspiration URL cards. NDJSON: {type:'text'|'urls'|'done'|'error'}.
        if (url.startsWith('/api/cocreate') && req.method === 'POST') {
          let body: any
          try {
            body = await readBody(req)
          } catch (e: any) {
            return json(res, 400, { error: `bad request body: ${e?.message || e}` })
          }
          const {
            seedText,
            contextNotes,
            transcriptWindow,
            kept,
            rejected,
            existingIdeas,
            provider = 'open',
            openSub = 'groq',
            model,
            webSearch = false,
            command
          } = body
          const isCommand = typeof command === 'string' && command.trim().length > 0
          if (!isCommand && (!seedText || typeof seedText !== 'string')) {
            return json(res, 400, { error: 'seedText or command is required' })
          }

          const signals = { kept, rejected, existingIdeas }
          const system = isCommand ? COMMAND_SYSTEM : COCREATE_SYSTEM
          const userText = isCommand
            ? buildCommandContext(command, contextNotes, transcriptWindow)
            : buildCocreateContext(seedText, contextNotes, transcriptWindow, signals)

          res.statusCode = 200
          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n')

          try {
            let resolvedModel: string | undefined

            if (provider === 'claude-code' || provider === 'codex') {
              const run = provider === 'claude-code' ? runClaude : runCodex
              resolvedModel = provider === 'claude-code' ? 'claude (subscription)' : 'codex (subscription)'
              const cliSystem = system + (webSearch ? CLI_SEARCH_INSTRUCTION : '')
              const urls: UrlCard[] = []
              for await (const ev of run({ prompt: userText, system: cliSystem, webSearch })) {
                if (ev.type === 'text') send({ type: 'text', text: ev.text })
                else if (ev.type === 'url') urls.push({ title: ev.title, url: ev.url, snippet: ev.snippet, image: ev.image })
              }
              // One increment at a time — at most a single inspiration card.
              if (urls.length) send({ type: 'urls', urls: urls.slice(0, 1) })
            } else {
              // provider === 'open': OpenAI-compatible model (+ Tavily for URLs).
              const cfg = (LLM[openSub as string] || LLM.groq)()
              if (model) cfg.model = model
              resolvedModel = cfg.model
              if (cfg.proxy && !cfg.key) {
                send({ type: 'error', error: `${openSub} needs an API key in .env` })
                return res.end()
              }
              // Generate bullets first; the model names the search query it would
              // run (reasoned from transcript + note). Then search with THAT query.
              const sys = system + (webSearch ? SEARCH_INSTRUCTION : '')
              const reasonedQuery = await streamOpenModel(cfg, sys, userText, (t) =>
                send({ type: 'text', text: t })
              )
              // Only search when the model decided one example would help (it emitted
              // a SEARCH line). One increment → at most a single card.
              if (webSearch && reasonedQuery) {
                const urls = await tavilySearch(reasonedQuery.trim(), 1).catch((e) => {
                  send({ type: 'error', error: `search: ${e?.message || e}` })
                  return [] as UrlCard[]
                })
                if (urls.length) send({ type: 'urls', urls: urls.slice(0, 1) })
              }
            }

            send({ type: 'done', model: resolvedModel, provider })
            res.end()
          } catch (e: any) {
            // Headers already sent — emit an NDJSON error line so the UI shows it.
            send({ type: 'error', error: e?.message || String(e) })
            res.end()
          }
          return
        }

        // --- GET /api/deepgram-key: hand the browser a key for direct WS ---
        // Throwaway-prototype shortcut. NOT production-safe (exposes the key to
        // the page). Fine for a local single-user demo; replace with temp-token
        // minting before anything ships.
        if (url.startsWith('/api/deepgram-key')) {
          return json(res, 200, { key: process.env.DEEPGRAM_API_KEY || '' })
        }

        // Soniox real-time multilingual key + model (same throwaway shortcut).
        if (url.startsWith('/api/soniox-key')) {
          return json(res, 200, {
            key: process.env.SONIOX_API_KEY || '',
            model: process.env.SONIOX_MODEL || 'stt-rt-v5'
          })
        }

        // Speechmatics: mint a short-lived RT JWT (browser WS can't send headers).
        if (url.startsWith('/api/speechmatics-token')) {
          const rtUrl = process.env.SPEECHMATICS_RT_URL || 'wss://eu2.rt.speechmatics.com/v2'
          const language = process.env.SPEECHMATICS_LANGUAGE || 'en'
          const key = process.env.SPEECHMATICS_API_KEY
          if (!key) return json(res, 200, { token: '', url: rtUrl, language })
          try {
            const r = await fetch('https://mp.speechmatics.com/v1/api_keys?type=rt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
              body: JSON.stringify({ ttl: 3600 }),
              dispatcher: getDispatcher()
            } as any)
            const d: any = await r.json()
            return json(res, 200, { token: d?.key_value || '', url: rtUrl, language })
          } catch (e: any) {
            return json(res, 500, { token: '', url: rtUrl, language, error: e?.message })
          }
        }

        // iFlytek 讯飞 RTASR: build the HMAC-signed wss URL. Proxy-free in CN.
        if (url.startsWith('/api/iflytek-url')) {
          const appid = process.env.IFLYTEK_APPID
          const apiKey = process.env.IFLYTEK_API_KEY
          if (!appid || !apiKey) return json(res, 200, { url: '' })
          const ts = Math.floor(Date.now() / 1000).toString()
          const md5 = crypto.createHash('md5').update(appid + ts).digest('hex')
          const signa = crypto.createHmac('sha1', apiKey).update(md5).digest('base64')
          const wss = `wss://rtasr.xfyun.cn/v1/ws?appid=${appid}&ts=${ts}&signa=${encodeURIComponent(signa)}`
          return json(res, 200, { url: wss })
        }

        // Gemini Live (experimental combined transcript+highlight) key + model.
        if (url.startsWith('/api/gemini-key')) {
          return json(res, 200, {
            key: process.env.GEMINI_API_KEY || '',
            model: process.env.GEMINI_LIVE_MODEL || 'gemini-2.0-flash-live-001'
          })
        }

        next()
      })
    }
  }
}

// ---- helpers ---------------------------------------------------------------
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, code: number, obj: unknown) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

// Context engineering for Tier-2: the seed idea + nearby canvas notes + the
// transcript window it came from. Deliberately small — this is the knob Jasmine
// tunes (what to send) and hands to Vandark.
function buildCocreateContext(
  seedText: string,
  contextNotes?: string[],
  transcriptWindow?: string,
  signals?: { kept?: string[]; rejected?: string[]; existingIdeas?: string[] }
): string {
  const parts: string[] = []
  if (transcriptWindow && transcriptWindow.trim()) {
    parts.push(`Full transcript so far:\n${transcriptWindow.trim()}`)
  }
  if (Array.isArray(contextNotes) && contextNotes.length) {
    parts.push(`What the user has written in this note:\n- ${contextNotes.join('\n- ')}`)
  }
  const kept = signals?.kept?.filter(Boolean)
  if (kept?.length) parts.push(`The user KEPT these suggestions (do MORE like this):\n- ${kept.join('\n- ')}`)
  const rejected = signals?.rejected?.filter(Boolean)
  if (rejected?.length) parts.push(`The user REJECTED these (AVOID this direction):\n- ${rejected.join('\n- ')}`)
  const existing = signals?.existingIdeas?.filter(Boolean)
  if (existing?.length) parts.push(`Already on the canvas — do NOT repeat any of these:\n- ${existing.join('\n- ')}`)
  parts.push(`The user's current focus:\n${seedText.trim()}\n\nAdd your single new increment now.`)
  return parts.join('\n\n')
}

// Tier-3 command context: the explicit instruction + whatever's on the canvas.
function buildCommandContext(
  command: string,
  contextNotes?: string[],
  transcriptWindow?: string
): string {
  const parts: string[] = []
  if (transcriptWindow && transcriptWindow.trim()) {
    parts.push(`Transcript so far:\n${transcriptWindow.trim()}`)
  }
  if (Array.isArray(contextNotes) && contextNotes.length) {
    parts.push(`Notes already on the canvas:\n- ${contextNotes.join('\n- ')}`)
  }
  parts.push(`Command:\n${command.trim()}`)
  return parts.join('\n\n')
}

function buildCleanTranscriptUserText(rawText: string, existingNotes?: string): string {
  const cleaned = typeof existingNotes === 'string' ? existingNotes.trim() : ''
  const parts: string[] = []
  if (cleaned) {
    parts.push(`Existing visible cleaned notes:\n${cleaned}`)
  }
  parts.push(`New raw STT chunk to integrate:\n${rawText.trim()}`)
  parts.push(
    `Return the full updated visible note. Do not repeat the same idea in multiple bullets. ` +
    `If the new chunk only clarifies an existing idea, revise that idea instead of adding a new bullet.`
  )
  return parts.join('\n\n')
}

// Stream an OpenAI-compatible chat completion as concise bullet LINES. Emits a
// completed line at a time via onText (so each bullet renders whole), strips Qwen
// <think>, and intercepts a trailing `SEARCH: <query>` line — returned, not shown,
// so it can drive Tavily. Covers Groq / Cerebras (proxied) and local Ollama.
async function streamOpenModel(
  cfg: { base: string; key: string; model: string; proxy: boolean },
  system: string,
  userText: string,
  onText: (t: string) => void
): Promise<string | undefined> {
  const noThink = /qwen3/i.test(cfg.model) ? ' /no_think' : ''
  const r = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.7,
      max_tokens: 512,
      stream: true,
      messages: [
        { role: 'system', content: system + noThink },
        { role: 'user', content: userText }
      ]
    }),
    ...(cfg.proxy ? { dispatcher: getDispatcher() } : {})
  } as any)

  if (!r.ok || !r.body) {
    throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }

  let searchQuery: string | undefined
  let line = '' // current (incomplete) output line

  // Decide what to do with one completed output line.
  const emitLine = (l: string) => {
    const m = l.match(/^\s*SEARCH:\s*(.+)$/i)
    if (m) { searchQuery = m[1].trim(); return } // capture, don't show
    if (l.trim()) onText(l + '\n')
  }

  const reader = (r.body as any).getReader()
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
      if (data === '[DONE]') { if (line) emitLine(line); return searchQuery }
      try {
        const piece = JSON.parse(data)?.choices?.[0]?.delta?.content
        if (typeof piece !== 'string' || !piece) continue
        // Strip any Qwen <think>…</think> that leaks through despite /no_think.
        let t = piece
        if (inThink) {
          const end = t.indexOf('</think>')
          if (end < 0) continue
          t = t.slice(end + 8)
          inThink = false
        }
        const open = t.indexOf('<think>')
        if (open >= 0) { t = t.slice(0, open); inThink = true }
        // Accumulate into the current line; flush on each newline.
        line += t
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

function parsePhrases(s: string): string[] {
  const out = s
    .split('\n')
    .map((l) =>
      l
        .replace(/^[\s\-*\d.)\]]+/, '') // strip bullets / numbering
        .replace(/^["'`]+|["'`]+$/g, '') // strip wrapping quotes
        .trim()
    )
    .filter((l) => l.length > 1)
  return [...new Set(out)]
}

function getReasoningParams(model: string): Record<string, string | boolean> {
  if (/qwen3\.6/i.test(model)) {
    return { reasoning_effort: 'none', include_reasoning: false }
  }
  // GPT-OSS models always reason, but Groq can hide the reasoning content.
  if (/gpt-oss/i.test(model)) {
    return { reasoning_effort: 'low', reasoning_format: 'hidden' }
  }
  return {}
}

function sanitizeCleanedTranscript(raw: string): string {
  let s = raw.replace(/```[\s\S]*?```/g, '').trim()

  // Remove closed reasoning blocks. If a model starts a reasoning block and
  // never closes it before max_tokens, discard it instead of rendering thoughts.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const openThink = s.search(/<think>/i)
  if (openThink >= 0) {
    const close = s.search(/<\/think>/i)
    if (close < 0 || close < openThink) return ''
    s = (s.slice(0, openThink) + s.slice(close + '</think>'.length)).trim()
  }

  // Safety net for models that leak markdown planning instead of <think>.
  const leakedReasoning =
    /thinking process|analy[sz]e user input|identify key elements|draft generation|constraints/i.test(s)
  if (leakedReasoning) return ''

  return s
}
