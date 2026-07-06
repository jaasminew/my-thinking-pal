import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getDispatcher } from './proxy'
import { runClaude, runCodex } from './agents'
import { tavilySearch, fetchOgImage } from './search'
import { fetchUrlMeta } from './url-meta'
import type { UrlCard } from '../services/llm/cocreate-types'

// ---- Ambient co-creation ----------------------------------------------------
// Strong model that BUILDS ON the user's thinking — never rewrites it. It gets
// the full transcript + the keyword note's contents as context, REASONS about
// what the user is reaching for, and replies with concise bullets (Figma model).
// Diagnose-then-contribute: the model FIRST finds the spot in the note that
// most needs outside help and decides what KIND of help fits (example, fresh
// alternatives, counterpoint, dropped transcript thread…) and HOW MUCH — no
// hand-enumerated move menu (bitter lesson: model judgment over human routers).
// The judgment is kept accountable by forcing it out loud as a DIAGNOSIS line
// (machine-only — the client stores it invisibly and tags kept/rejected with it,
// so reactions teach the model which KINDS of help land). PASS is a legitimate
// answer: a note that's flowing needs silence, not decoration.
const COCREATE_SYSTEM =
  `You are an AMBIENT co-creation partner inside a "keyword note" on a thinking canvas. ` +
  `You receive the transcript of the user's spoken thinking, the note's keyword and bullets, ` +
  `and what they KEPT (liked) / REJECTED (disliked) from your earlier suggestions — kept and ` +
  `rejected entries may carry "[offered because: …]" tags showing why each was offered; use ` +
  `them to learn which KINDS of help this user wants, not just which texts. ` +
  `You may also receive HIGHLIGHTS extracted from the conversation, each tagged by kind — ` +
  `judgment, objection, example, or decision (with speaker tags in multi-speaker sessions). ` +
  `Weight your contribution by the kind of thought you respond to: an objection wants ` +
  `counter-evidence or a resolution path; a judgment wants supporting or challenging evidence; ` +
  `an example wants the general principle behind it; a decision wants consequences or execution ` +
  `risks. Never mention these tags. ` +
  `Work in two steps. ` +
  `STEP 1 — DIAGNOSE: find the ONE spot in the note that most needs outside input right now ` +
  `(an unsupported claim, a vague idea needing a concrete real-world case, a stalled direction ` +
  `needing fresh alternatives, a hidden assumption worth challenging, a promising transcript ` +
  `thread the user dropped…). Decide what kind of contribution serves THAT spot best, and how much. ` +
  `STEP 2 — CONTRIBUTE: produce exactly that, GROUNDED in reality. Whatever the kind, anchor ` +
  `it in something real and NAMED: an opinion or counterpoint needs evidence (a product, ` +
  `project, paper, or event that demonstrates it); a creative direction gains force from a ` +
  `precedent that proves its key ingredient works. When you name a case, say in one line HOW ` +
  `it does the thing. A grounded bullet beats a clever but unanchored one — reach for an ` +
  `abstract-only bullet only when nothing real fits. Grounding lives in your WORDS: naming ` +
  `the case and explaining HOW is complete in itself — it does not require a link. ` +
  `Output format (strict): ` +
  `Line 1: "DIAGNOSIS: <one short line — the spot + what it needs>". It is machine-read and never shown. ` +
  `Line 2: "ANCHOR: <n>" — the number of the user's bullet (from the numbered note list) that your ` +
  `contribution most directly builds on, so it can be placed right under that thought; or "ANCHOR: NONE" ` +
  `when it speaks to the note as a whole. Also machine-read, never shown. ` +
  `Then EITHER the single word "PASS" on its own line (the note is doing fine on its own — a fully ` +
  `legitimate answer; never force a contribution) OR 1-3 bullet lines starting with "- ", each ≤ 25 words. ` +
  `Use the SMALLEST number of bullets that serves the diagnosis — one sharp bullet usually beats three. ` +
  `Do NOT repeat or restate the user's words or anything already on the canvas; go somewhere NEW. ` +
  `Lean toward what the user KEPT; avoid the directions they REJECTED. ` +
  `Write in the language the user's note is written in. ` +
  `No preamble, no lines outside this format.`

// ---- Tier-3 command (Unit 2) -----------------------------------------------
// Explicit instruction typed into the command box ("go search some voice-to-text
// products"). Same concise-bullet output; web search supplies inspiration URLs.
const COMMAND_SYSTEM =
  `You are an assistant inside a keyword note on a thinking canvas. The user gives an ` +
  `explicit command, with the transcript and their notes as context. Carry it out and ` +
  `reply with ONE concise bullet (≤ 14 words) starting with "- ". No preamble, no extra lines.`

// ---- Tier-3 command CHAT (select text → bubble → side panel) -----------------
// A conversational assistant, not the cocreate bullet format: it answers in
// prose and may propose canvas actions via the ACTION line protocol below.
// Actions are structure smuggled through a text-only stream (the CLIs emit
// plain text) — the server strips ACTION lines out and forwards them as typed
// NDJSON events; the user only ever sees buttons.
const COMMAND_CHAT_SYSTEM =
  `You are a contextual AI assistant in a chat side panel of a "thinking canvas" app. ` +
  `The user summoned you from text they selected in one of their keyword notes (or from a ` +
  `command box). You may receive: the SELECTED TEXT (your primary referent), the source ` +
  `note's keyword and bullets, reaction signals (KEPT / REJECTED), and a 1-minute window ` +
  `of the user's spoken transcript. ` +
  `Answer conversationally and concretely; keep replies short and useful. Match the ` +
  `user's language. Never rewrite or restate their content — the canvas belongs to them. ` +
  `When, and only when, the user's request implies ADDING something to the canvas, append ` +
  `proposal lines AFTER your prose, each on its own line, at most 4 per reply, exactly: ` +
  `ACTION: {"type":"insert-bullet","text":"<one concise bullet, ≤25 words>"} ` +
  `ACTION: {"type":"add-card","title":"<page title>","url":"https://…","snippet":"<one line>"} ` +
  `ACTION: {"type":"append-image","caption":"<≤12 words naming what the image shows>","url":"https://<PAGE url, not an image file>","title":"<case name>"} ` +
  `ACTION: {"type":"create-note","keyword":"<2-5 word header>","bullets":["<bullet>","<bullet>"]} ` +
  `The JSON must be valid and single-line; one action per line; never mention these lines ` +
  `in your prose (the user sees them as buttons). Card/image URLs must be REAL pages you ` +
  `found via search or genuinely know — never invent URLs. Do not reveal reasoning.`

// CLI providers have a native web search tool; make them actually use it when
// the user asks for anything current, and keep proposed URLs grounded in it.
const COMMAND_CHAT_CLI_SEARCH =
  `\n\nYou have a web search tool. When the user asks for products, examples, links, ` +
  `evidence, or anything current — actually RUN a search before answering, and base any ` +
  `add-card / append-image actions only on pages the search returned.`

// Line filter for the ACTION protocol: whole lines only (a chunk boundary can
// split "ACT|ION:", so classifying anything smaller would leak protocol text
// into chat). ACTION lines go to onAction as raw JSON; all other lines stream
// through as chat text, blank lines included (they are paragraph breaks).
function makeCommandActionFilter(
  emitText: (t: string) => void,
  onAction: (rawJson: string) => void
) {
  let buf = ''
  const handleLine = (l: string) => {
    const m = l.match(/^\s*ACTION:\s*(\{.*\})\s*$/)
    if (m) {
      onAction(m[1])
      return
    }
    emitText(l + '\n')
  }
  return {
    push(text: string) {
      buf += text
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    },
    flush() {
      if (buf.trim()) handleLine(buf)
      buf = ''
    }
  }
}

// Open-model path can't search on its own, so we ask it to name the query it
// would search — that reasoned query drives Tavily (CLIs search natively).
const SEARCH_INSTRUCTION =
  `\n\nAfter your bullets you may add ONE final line that fetches a reference for the case ` +
  `you named. Choose by what serves the user, keeping a genuine mix across fires — never ` +
  `collapse into one form: ` +
  `"SEARCH: <one focused query>" (a query that finds the page about the case you named, ` +
  `e.g. "Notion block data model") when the page itself is worth the user's visit — a ` +
  `product to try, a paper to read in full. It becomes a link card. ` +
  `"SEARCH IMAGE: <one focused query>" when the case is inherently VISUAL — a UI, a ` +
  `diagram, a physical object — and one glance beats any words; the image renders inside ` +
  `your bullet, no jump. ` +
  `Add neither when your words alone carry it — pure reasoning, a question, a reframe. ` +
  `Never add one on PASS. Put nothing after it.`

// CLI providers (Claude/Codex) search natively, and the structured results are
// harvested into URL cards automatically. We must (a) force an actual search, yet
// (b) keep the reply to just bullets — no preamble, no Sources list (those leak in
// as bullets). "Search now" forces the tool; "start with the first bullet" trims
// the chatter. (Telling it to be fully "silent" made it skip searching entirely.)
const CLI_SEARCH_INSTRUCTION =
  `\n\nUnless you PASS, use your web search tool NOW (actually run it) BEFORE writing — ` +
  `your contribution must rest on a real, current case, and searching is how you get it ` +
  `right. Then choose how to PRESENT that case. Keep a genuine mix across fires — never ` +
  `collapse into one form: ` +
  `WORDS — name the case and how it works, when your one line carries the insight. ` +
  `LINK — write the case's NAME as a markdown link, "- [Notion](https://…) stores ` +
  `everything as blocks…", when the page itself is worth the user's visit (a product to ` +
  `try, a paper to read in full). It becomes a link card. ` +
  `IMAGE — write markdown image syntax with the PAGE url, "- ![Teenage Engineering ` +
  `OP-1](https://teenage.engineering/products/op-1) proves dense controls can feel ` +
  `playful", when the case is inherently VISUAL (a UI, a diagram, a physical object) — ` +
  `the page's own header image is fetched and rendered inside your bullet. Never guess a ` +
  `direct image-file url. ` +
  `Rule of thumb: words for pure reasoning, link when acting on the page helps, image ` +
  `when seeing beats reading. ` +
  `Keep the output format above exactly: no preamble, no "Sources" list, no bare URLs.`

// Line-level filter for the diagnose-then-contribute protocol: captures the
// leading "DIAGNOSIS: …" line (surfaced as its own NDJSON event, never as text),
// the "ANCHOR: <n>|NONE" line (which user bullet the fire builds on — placement),
// and a bare "PASS" line (suppressed — the fire contributes nothing), passing
// every other completed line through. Buffering whole lines costs a little
// streaming granularity, but bullets are ≤ 25 words — line-at-a-time still
// feels live, and it's the only safe way to catch protocol lines mid-stream.
function makeProtocolFilter(
  emit: (text: string) => void,
  onDiagnosis: (d: string) => void,
  onAnchor?: (line: number) => void
) {
  let buf = ''
  let passed = false
  let contentLines = 0 // content lines emitted so far — anchors inline images to bullets
  const handleLine = (l: string) => {
    const dm = l.match(/^\s*DIAGNOSIS:\s*(.*)$/i)
    if (dm) {
      if (dm[1].trim()) onDiagnosis(dm[1].trim())
      return
    }
    const am = l.match(/^\s*ANCHOR:\s*(\S+)/i)
    if (am) {
      const n = parseInt(am[1], 10)
      if (Number.isFinite(n) && n >= 0) onAnchor?.(n) // "NONE" parses NaN → no event
      return
    }
    if (/^\s*PASS[.!]?\s*$/i.test(l)) {
      passed = true
      return
    }
    if (l.trim()) {
      contentLines++
      emit(l + '\n')
    }
  }
  return {
    push(text: string) {
      buf += text
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    },
    flush() {
      if (buf.trim()) handleLine(buf)
      buf = ''
    },
    get passed() {
      return passed
    },
    get contentLines() {
      return contentLines
    }
  }
}

// CLI models sometimes inline "[title](url)" or a bare URL in the bullet despite
// instructions. The canvas renders bullet text raw (no markdown), so we strip
// links out of the streamed text and surface them as URL cards instead. Streaming-
// safe: a trailing fragment that may be a link still mid-stream is held back
// until the next chunk (or flush).
function makeLinkStripper(
  emit: (text: string) => void,
  onUrl: (u: UrlCard) => void,
  onImage?: (im: { title: string; url: string }) => void
) {
  let buf = ''
  const MD_IMG = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g
  const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g
  const process = (final: boolean) => {
    // Markdown IMAGE syntax first (a plain-link match would leave the "!"
    // behind): "![Notion](url)" = the words+image register — the page url is
    // resolved to its og:image later; keep the name in the text.
    let s = buf.replace(MD_IMG, (_, title: string, url: string) => {
      onImage?.({ title: title || url, url })
      return title
    })
    // Complete markdown links → card; keep the human-readable title in the text.
    s = s.replace(MD_LINK, (_, title: string, url: string) => {
      onUrl({ title: title || url, url })
      return title
    })
    // Bare URLs: mid-text ones (whitespace-terminated) are complete — extract.
    s = s.replace(/https?:\/\/[^\s)\]]+(?=\s)/g, (url) => {
      onUrl({ title: url, url })
      return ''
    })
    if (final) {
      s = s.replace(/https?:\/\/[^\s)\]]+/g, (url) => {
        onUrl({ title: url, url })
        return ''
      })
      buf = ''
      if (s) emit(s)
      return
    }
    // Hold back anything that might be an incomplete link still streaming
    // (including a "!" that may be starting a markdown image).
    let hold = s.length
    const lb = s.lastIndexOf('[')
    if (lb >= 0 && !s.slice(lb).includes(')')) hold = Math.min(hold, lb > 0 && s[lb - 1] === '!' ? lb - 1 : lb)
    const tailUrl = s.match(/https?:\/\/\S*$/)
    if (tailUrl?.index !== undefined) hold = Math.min(hold, tailUrl.index)
    if (hold > 0) emit(s.slice(0, hold))
    buf = s.slice(hold)
  }
  return {
    push(text: string) {
      buf += text
      process(false)
    },
    flush() {
      process(true)
    }
  }
}

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

        // --- POST /api/extract-signals: raw speech window -> typed pending signals ---
        // Precision over recall: the model KEEPS only the six signal types and
        // discards greetings/fillers/small talk. A parsed empty list is a real
        // answer (the engine discards the window); skipped=true means "nothing
        // parseable" (the engine puts the raw back and retries).
        if (url.startsWith('/api/extract-signals') && req.method === 'POST') {
          try {
            const { systemPrompt, rawText, existingSignals, provider, model } = await readBody(req)
            if (!rawText || typeof rawText !== 'string') {
              return json(res, 400, { error: 'rawText is required', signals: [], serverMs: 0 })
            }

            const cfg = (LLM[provider] || LLM.groq)()
            if (model) cfg.model = model
            if (cfg.proxy && !cfg.key) {
              return json(res, 400, { error: `${provider} needs an API key in .env`, signals: [] })
            }

            // Classification wants real thinking; keep it hidden and leave room
            // for the JSON after the reasoning so the answer is never starved.
            const reasoningParams = /gpt-oss/i.test(cfg.model)
              ? { reasoning_effort: 'medium', reasoning_format: 'hidden' }
              : getReasoningParams(cfg.model)

            const sys =
              `${systemPrompt}\n\n` +
              `Return ONLY a JSON object of exactly this shape: ` +
              `{"signals":[{"type":"<judgment|objection|example|decision>",` +
              `"text":"<one concise, written-style sentence>","speaker":"<S1|S2|… if speaker tags appear in the raw, else omit>"}]}. ` +
              `The only valid types are judgment, objection, example, decision — there is NO question or hesitation type. ` +
              `An EMPTY signals list is the NORMAL answer for most windows; only rare, genuinely thought-changing statements earn a slot. ` +
              `No prose, no markdown, no code fences — output only the JSON object.`
            const userText = buildExtractSignalsUserText(rawText, existingSignals)

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
                max_tokens: 3000,
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
              // skipped=true → the engine keeps the raw and retries next tick.
              return json(res, 200, { error: `LLM ${r.status}: ${body.slice(0, 300)}`, skipped: true, signals: [], serverMs })
            }
            const data: any = await r.json()
            const raw = data?.choices?.[0]?.message?.content || ''
            const signals = parseSignals(raw)
            if (signals === null) {
              // Nothing parseable (e.g. reasoning ate the budget) — retry case,
              // NOT the legitimate-empty case.
              return json(res, 200, { signals: [], skipped: true, serverMs, model: cfg.model })
            }
            return json(res, 200, { signals, serverMs, model: cfg.model })
          } catch (e: any) {
            return json(res, 200, { error: e?.message || String(e), skipped: true, signals: [], serverMs: 0 })
          }
        }

        // --- POST /api/section-header: closed section body -> short title ---
        // Fired async when a topic boundary closes a section. Small + fast.
        if (url.startsWith('/api/section-header') && req.method === 'POST') {
          try {
            const { body: sectionBody, provider, model } = await readBody(req)
            if (!sectionBody || typeof sectionBody !== 'string') {
              return json(res, 400, { error: 'body is required', header: '', serverMs: 0 })
            }

            const cfg = (LLM[provider] || LLM.groq)()
            if (model) cfg.model = model
            if (cfg.proxy && !cfg.key) {
              return json(res, 400, { error: `${provider} needs an API key in .env`, header: '' })
            }

            const sys =
              `You write a short section title for a block of thinking notes. ` +
              `Reply with ONLY the title: 3-6 words, sentence case, no quotes, no trailing punctuation. ` +
              `Match the language of the notes (Chinese notes -> Chinese title). ` +
              `No commentary, no markdown, no code fences.`
            const t0 = performance.now()
            const r = await fetch(`${cfg.base}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
              body: JSON.stringify({
                model: cfg.model,
                temperature: 0.2,
                max_tokens: 40,
                ...getReasoningParams(cfg.model),
                messages: [
                  { role: 'system', content: sys },
                  { role: 'user', content: String(sectionBody).replace(/==/g, '').slice(0, 1200) }
                ]
              }),
              ...(cfg.proxy ? { dispatcher: getDispatcher() } : {})
            } as any)

            const serverMs = Math.round(performance.now() - t0)
            if (!r.ok) {
              const errBody = await r.text()
              return json(res, 502, { error: `LLM ${r.status}: ${errBody.slice(0, 200)}`, serverMs, header: '' })
            }
            const data: any = await r.json()
            const rawHeader = data?.choices?.[0]?.message?.content || ''
            const header = sanitizeCleanedTranscript(rawHeader).replace(/^[-*#>\s]+/, '').replace(/["'“”]/g, '').trim()
            return json(res, 200, { header, serverMs, model: cfg.model })
          } catch (e: any) {
            return json(res, 500, { error: e?.message || String(e), header: '', serverMs: 0 })
          }
        }

        // --- POST /api/organize: pending signals (numbered) -> titled sections ---
        // The organize pass. A THINKING model reads only the pending tail and
        // returns sections whose items REFERENCE input lines by index (so a
        // rewrite keeps its source timestamps/types). Runs async every ~5min +
        // on stop. Never returns an HTTP error to the browser: any failure
        // yields empty sections, which the engine treats as "no organize this
        // round". The model's raw reply is PARSED (not printed), so leaked
        // reasoning can't reach the UI even if it slips past
        // reasoning_format:'hidden'.
        if (url.startsWith('/api/organize') && req.method === 'POST') {
          try {
            const { lines, closing, provider, model } = await readBody(req)
            if (!lines || typeof lines !== 'string') {
              return json(res, 400, { error: 'lines is required', sections: [], serverMs: 0 })
            }

            // Subscription CLI backends (chosen globally alongside co-creation):
            // organize is the highest-judgment, lowest-frequency, most latency-
            // tolerant pass, so it's the one worth spending a strong model on.
            // The CLI streams plain text; we collect it whole and parse the JSON.
            if (provider === 'claude-code' || provider === 'codex') {
              const t0 = performance.now()
              try {
                const raw = await runAgentToText(
                  provider,
                  buildOrganizeSystem(!!closing),
                  String(lines).slice(0, 8000)
                )
                const serverMs = Math.round(performance.now() - t0)
                return json(res, 200, { sections: parseOrganize(raw), serverMs, model: `${provider} (subscription)` })
              } catch (e: any) {
                const serverMs = Math.round(performance.now() - t0)
                // Surface (empty sections keep the engine safe): a misconfigured
                // CLI would otherwise silently no-op every organize round.
                return json(res, 200, { error: e?.message || String(e), sections: [], serverMs })
              }
            }

            const cfg = (LLM[provider] || LLM.groq)()
            if (model) cfg.model = model
            if (cfg.proxy && !cfg.key) {
              return json(res, 400, { error: `${provider} needs an API key in .env`, sections: [] })
            }

            // Enable real thinking but hide it, and leave room for the JSON after
            // the (hidden) reasoning so the answer is never starved.
            const reasoningParams = /gpt-oss/i.test(cfg.model)
              ? { reasoning_effort: 'medium', reasoning_format: 'hidden' }
              : getReasoningParams(cfg.model)

            const t0 = performance.now()
            const r = await fetch(`${cfg.base}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
              body: JSON.stringify({
                model: cfg.model,
                temperature: 0.2,
                max_tokens: 3000,
                ...reasoningParams,
                messages: [
                  { role: 'system', content: buildOrganizeSystem(!!closing) },
                  { role: 'user', content: String(lines).slice(0, 8000) }
                ]
              }),
              ...(cfg.proxy ? { dispatcher: getDispatcher() } : {})
            } as any)

            const serverMs = Math.round(performance.now() - t0)
            if (!r.ok) {
              const errBody = await r.text()
              // 200 + empty so the engine silently skips rather than showing an error.
              return json(res, 200, { error: `LLM ${r.status}: ${errBody.slice(0, 200)}`, sections: [], serverMs })
            }
            const data: any = await r.json()
            const rawReply = data?.choices?.[0]?.message?.content || ''
            return json(res, 200, { sections: parseOrganize(rawReply), serverMs, model: cfg.model })
          } catch (e: any) {
            return json(res, 200, { error: e?.message || String(e), sections: [], serverMs: 0 })
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
            seedType,
            contextNotes,
            transcriptWindow,
            signalWindow,
            kept,
            rejected,
            existingIdeas,
            provider = 'codex',
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
            ? buildCommandContext(command, contextNotes, transcriptWindow, signalWindow)
            : buildCocreateContext(seedText, contextNotes, transcriptWindow, signals, signalWindow, seedType)

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
              // Cards come ONLY from links the model deliberately cites inline —
              // linking is a judged decision (words usually carry the grounding),
              // so raw search results are never auto-surfaced as cards. Markdown
              // IMAGE syntax = the words+image register: the bullet keeps the
              // case's name and gets the page's og:image rendered inline.
              const cited: UrlCard[] = []
              const inlineImages: { title: string; url: string; line: number }[] = []
              const strip = makeLinkStripper(
                (t) => send({ type: 'text', text: t }),
                (u) => { if (!cited.some((c) => c.url === u.url)) cited.push(u) },
                (im) => {
                  // ≤ 1 inline image per fire; line anchors it to its bullet.
                  if (!inlineImages.length) inlineImages.push({ ...im, line: proto.contentLines - 1 })
                }
              )
              // Protocol filter first (whole lines: catches DIAGNOSIS/PASS),
              // then the link stripper on the surviving content lines.
              const proto = makeProtocolFilter(
                (l) => strip.push(l),
                (d) => send({ type: 'diagnosis', text: d }),
                (a) => send({ type: 'anchor', line: a })
              )
              for await (const ev of run({ prompt: userText, system: cliSystem, webSearch })) {
                if (ev.type === 'text') proto.push(ev.text)
                // ev.type === 'url' (raw search results) deliberately ignored.
              }
              proto.flush()
              strip.flush()
              // ≤ 3 cards (matching the bullet cap); none on PASS. Thumbnails
              // come from each cited page's own og:image (provably matching —
              // unlike the old positional Tavily pairing).
              const cards = cited.slice(0, 3)
              if (cards.length && !proto.passed) {
                await Promise.all(cards.map(async (c) => { c.image = await fetchOgImage(c.url) }))
                send({ type: 'urls', urls: cards })
              }
              const im = inlineImages[0]
              if (im && !proto.passed) {
                const src = await fetchOgImage(im.url)
                // Graceful degrade: page yields no image → keep the reference
                // as a link card rather than dropping it silently.
                if (src) send({ type: 'image', src, sourceUrl: im.url, title: im.title, line: im.line })
                else send({ type: 'urls', urls: [{ title: im.title, url: im.url }] })
              }
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
              // streamOpenModel emits whole lines, so the protocol filter sees
              // complete DIAGNOSIS/PASS lines immediately.
              const proto = makeProtocolFilter(
                (t) => send({ type: 'text', text: t }),
                (d) => send({ type: 'diagnosis', text: d }),
                (a) => send({ type: 'anchor', line: a })
              )
              const reasonedQuery = await streamOpenModel(cfg, sys, userText, (t) =>
                proto.push(t)
              )
              proto.flush()
              // Only search when the model chose a register that needs it (it
              // emitted a SEARCH / SEARCH IMAGE line) and didn't PASS.
              if (webSearch && reasonedQuery && !proto.passed) {
                const urls = await tavilySearch(reasonedQuery.query, 1).catch((e) => {
                  send({ type: 'error', error: `search: ${e?.message || e}` })
                  return [] as UrlCard[]
                })
                const u = urls[0]
                if (u) {
                  const src = await fetchOgImage(u.url)
                  if (reasonedQuery.image && src) {
                    // words + image: rendered inside the LAST bullet (the SEARCH
                    // line follows the bullets, so that's the one it grounds).
                    send({ type: 'image', src, sourceUrl: u.url, title: u.title, line: proto.contentLines - 1 })
                  } else {
                    // words + link (or image intent that found no og:image —
                    // degrade to a card so the reference isn't lost).
                    send({ type: 'urls', urls: [{ ...u, image: src }] })
                  }
                }
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

        // --- POST /api/command-chat: Tier-3 chat turn -> streamed NDJSON ---
        // Stateless: the client sends the FULL history + freshly captured
        // context every turn; we flatten it into one prompt and make one
        // fresh backend call. Events: {type:'text'|'action'|'done'|'error'}.
        if (url.startsWith('/api/command-chat') && req.method === 'POST') {
          let body: any
          try {
            body = await readBody(req)
          } catch (e: any) {
            return json(res, 400, { error: `bad request body: ${e?.message || e}` })
          }
          const { provider = 'codex', openSub = 'groq', model, webSearch = false, messages, context } = body
          if (!Array.isArray(messages) || !messages.length) {
            return json(res, 400, { error: 'messages[] is required' })
          }
          // Actions land in the SOURCE note; the model never sees note ids —
          // we inject this one, so it can't be wrong. No source note (bottom-
          // bar session) → only create-note actions are possible.
          const sourceNoteId = typeof context?.sourceNoteId === 'string' ? context.sourceNoteId : undefined

          res.statusCode = 200
          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n')

          const userText = buildCommandChatPrompt(messages, context)

          try {
            let resolvedModel: string | undefined
            let actionCount = 0
            // append-image actions defer until after the stream: the model
            // names a PAGE url; we resolve its og:image (no image → degrade
            // to a link card so the reference isn't lost).
            const pendingImages: { caption: string; url: string; title?: string }[] = []

            // Validate + retype one raw ACTION json. Malformed or unknown →
            // dropped silently (never show the user a broken protocol line).
            const handleActionJson = (raw: string) => {
              if (actionCount >= 6) return
              let a: any
              try {
                a = JSON.parse(raw)
              } catch {
                console.warn('[command-chat] dropping malformed ACTION json:', raw.slice(0, 120))
                return
              }
              if (a?.type === 'insert-bullet' && sourceNoteId && typeof a.text === 'string' && a.text.trim()) {
                actionCount++
                send({ type: 'action', action: { type: 'insert-bullet', noteId: sourceNoteId, text: a.text.trim() } })
              } else if (a?.type === 'add-card' && sourceNoteId && typeof a.title === 'string' && typeof a.url === 'string' && /^https?:\/\//.test(a.url)) {
                actionCount++
                send({
                  type: 'action',
                  action: {
                    type: 'add-card',
                    noteId: sourceNoteId,
                    title: a.title,
                    url: a.url,
                    snippet: typeof a.snippet === 'string' ? a.snippet : undefined
                  }
                })
              } else if (a?.type === 'append-image' && sourceNoteId && typeof a.caption === 'string' && typeof a.url === 'string' && /^https?:\/\//.test(a.url)) {
                actionCount++
                pendingImages.push({ caption: a.caption, url: a.url, title: typeof a.title === 'string' ? a.title : undefined })
              } else if (a?.type === 'create-note' && typeof a.keyword === 'string' && a.keyword.trim() && Array.isArray(a.bullets)) {
                actionCount++
                send({
                  type: 'action',
                  action: {
                    type: 'create-note',
                    keyword: a.keyword.trim(),
                    bullets: a.bullets.filter((b: any) => typeof b === 'string' && b.trim())
                  }
                })
              } else {
                console.warn('[command-chat] dropping invalid ACTION:', raw.slice(0, 120))
              }
            }

            const filter = makeCommandActionFilter((t) => send({ type: 'text', text: t }), handleActionJson)

            if (provider === 'claude-code' || provider === 'codex') {
              const run = provider === 'claude-code' ? runClaude : runCodex
              resolvedModel = provider === 'claude-code' ? 'claude (subscription)' : 'codex (subscription)'
              const sys = COMMAND_CHAT_SYSTEM + (webSearch ? COMMAND_CHAT_CLI_SEARCH : '')
              for await (const ev of run({ prompt: userText, system: sys, webSearch })) {
                if (ev.type === 'text') filter.push(ev.text)
                // raw 'url' harvest events ignored: chat cards come only from
                // ACTION proposals the model deliberately made.
              }
              filter.flush()
            } else {
              // provider === 'open': text-only chat (no native search tool;
              // the prompt forbids invented URLs, so actions stay grounded).
              const cfg = (LLM[openSub as string] || LLM.groq)()
              if (model) cfg.model = model
              resolvedModel = cfg.model
              if (cfg.proxy && !cfg.key) {
                send({ type: 'error', error: `${openSub} needs an API key in .env` })
                return res.end()
              }
              await streamOpenModel(cfg, COMMAND_CHAT_SYSTEM, userText, (t) => filter.push(t))
              filter.flush()
            }

            for (const im of pendingImages) {
              const src = await fetchOgImage(im.url)
              if (src) {
                send({
                  type: 'action',
                  action: { type: 'append-image', noteId: sourceNoteId!, src, sourceUrl: im.url, title: im.title, caption: im.caption }
                })
              } else {
                send({
                  type: 'action',
                  action: { type: 'add-card', noteId: sourceNoteId!, title: im.title || im.caption, url: im.url }
                })
              }
            }

            send({ type: 'done', model: resolvedModel, provider })
            res.end()
          } catch (e: any) {
            send({ type: 'error', error: e?.message || String(e) })
            res.end()
          }
          return
        }

        // --- GET /api/url-meta?url=… : og description + image for a card ---
        if (url.startsWith('/api/url-meta')) {
          const target = new URL(url, 'http://localhost').searchParams.get('url') || ''
          if (!/^https?:\/\//.test(target)) return json(res, 400, {})
          return json(res, 200, await fetchUrlMeta(target))
        }

        // Soniox real-time multilingual key + model (same throwaway shortcut).
        if (url.startsWith('/api/soniox-key')) {
          return json(res, 200, {
            key: process.env.SONIOX_API_KEY || '',
            model: process.env.SONIOX_MODEL || 'stt-rt-v5'
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

// Run a subscription CLI backend (Claude Code / Codex) to completion and return
// its full text output — for non-streamed, parse-the-whole-reply passes like
// organize. webSearch is off (organize reasons over the given signals only).
async function runAgentToText(
  provider: 'claude-code' | 'codex',
  system: string,
  prompt: string
): Promise<string> {
  const run = provider === 'claude-code' ? runClaude : runCodex
  let text = ''
  for await (const ev of run({ prompt, system, webSearch: false })) {
    if (ev.type === 'text') text += ev.text
  }
  return text
}

// Context engineering for Tier-2: the seed idea + nearby canvas notes + the
// transcript window it came from. Deliberately small — this is the knob Jasmine
// tunes (what to send) and hands to Vandark.
function buildCocreateContext(
  seedText: string,
  contextNotes?: string[],
  transcriptWindow?: string,
  signals?: { kept?: string[]; rejected?: string[]; existingIdeas?: string[] },
  signalWindow?: string,
  seedType?: string
): string {
  const parts: string[] = []
  if (transcriptWindow && transcriptWindow.trim()) {
    parts.push(`Full transcript so far:\n${transcriptWindow.trim()}`)
  }
  if (signalWindow && signalWindow.trim()) {
    parts.push(
      `Signals extracted from this conversation, tagged by kind (the user never sees these tags — ` +
        `use them to judge what kind of contribution fits):\n${signalWindow.trim()}`
    )
  }
  if (Array.isArray(contextNotes) && contextNotes.length) {
    // Numbered so the model can name its ANCHOR; leading spaces = outline depth.
    parts.push(
      `What the user has written in this note (numbered; indented lines are sub-points):\n` +
        contextNotes.map((t, i) => `${i}. ${t}`).join('\n')
    )
  }
  const kept = signals?.kept?.filter(Boolean)
  if (kept?.length) parts.push(`The user KEPT these suggestions (do MORE like this):\n- ${kept.join('\n- ')}`)
  const rejected = signals?.rejected?.filter(Boolean)
  if (rejected?.length) parts.push(`The user REJECTED these (AVOID this direction):\n- ${rejected.join('\n- ')}`)
  const existing = signals?.existingIdeas?.filter(Boolean)
  if (existing?.length) parts.push(`Already on the canvas — do NOT repeat any of these:\n- ${existing.join('\n- ')}`)
  const typed = seedType && seedType.trim() ? ` (spoken as a ${seedType.trim()})` : ''
  parts.push(`The user's current focus${typed}:\n${seedText.trim()}\n\nAdd your single new increment now.`)
  return parts.join('\n\n')
}

// Tier-3 command context: the explicit instruction + whatever's on the canvas.
function buildCommandContext(
  command: string,
  contextNotes?: string[],
  transcriptWindow?: string,
  signalWindow?: string
): string {
  const parts: string[] = []
  if (transcriptWindow && transcriptWindow.trim()) {
    parts.push(`Transcript so far:\n${transcriptWindow.trim()}`)
  }
  if (signalWindow && signalWindow.trim()) {
    parts.push(`Signals extracted from the conversation (typed):\n${signalWindow.trim()}`)
  }
  if (Array.isArray(contextNotes) && contextNotes.length) {
    parts.push(`Notes already on the canvas:\n- ${contextNotes.join('\n- ')}`)
  }
  parts.push(`Command:\n${command.trim()}`)
  return parts.join('\n\n')
}

// Tier-3 command-chat prompt: flatten the full chat history + this turn's
// freshly captured context into ONE prompt (the backends are stateless one-
// shot calls — this replay IS the session memory).
function buildCommandChatPrompt(
  messages: { role: string; text: string }[],
  context: any
): string {
  const parts: string[] = []
  if (typeof context?.transcriptWindow === 'string' && context.transcriptWindow.trim()) {
    parts.push(`Spoken transcript around this note (1 min):\n${context.transcriptWindow.trim()}`)
  }
  const sn = context?.sourceNote
  if (sn && typeof sn === 'object') {
    const lines: string[] = [`Keyword: ${sn.keyword || '(untitled)'}`]
    if (Array.isArray(sn.humanBullets) && sn.humanBullets.length) {
      lines.push(`The user's bullets (indented lines are sub-points):\n${sn.humanBullets.map((t: string) => `- ${t}`).join('\n')}`)
    }
    if (Array.isArray(sn.keptAi) && sn.keptAi.length) {
      lines.push(`AI contributions the user already KEPT:\n${sn.keptAi.map((t: string) => `- ${t}`).join('\n')}`)
    }
    parts.push(`Source note:\n${lines.join('\n')}`)
    if (Array.isArray(sn.kept) && sn.kept.length) {
      parts.push(`The user KEPT these earlier suggestions (do MORE like this):\n- ${sn.kept.join('\n- ')}`)
    }
    if (Array.isArray(sn.rejected) && sn.rejected.length) {
      parts.push(`The user REJECTED these (AVOID this direction):\n- ${sn.rejected.join('\n- ')}`)
    }
  }
  if (typeof context?.selectedText === 'string' && context.selectedText.trim()) {
    parts.push(`SELECTED TEXT (the user summoned you about this):\n"${context.selectedText.trim()}"`)
  }
  const hist = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${String(m.text ?? '')}`)
    .join('\n\n')
  parts.push(`Conversation so far:\n${hist}\n\nRespond to the last user message now.`)
  return parts.join('\n\n')
}

function buildExtractSignalsUserText(rawText: string, existingSignals?: string): string {
  const existing = typeof existingSignals === 'string' ? existingSignals.trim() : ''
  const parts: string[] = []
  if (existing) {
    parts.push(
      `Highlights already extracted (context only — do NOT re-emit these or near-duplicates of them, ` +
        `UNLESS the new speech sharpens one into a firmer statement, e.g. a tentative judgment that became a decision):\n${existing}`
    )
  }
  parts.push(`New raw speech window ([S1]/[S2] tags mark speaker turns):\n${rawText.trim()}`)
  return parts.join('\n\n')
}

// Backstop: only these four labels survive. If the model slips and emits a
// "question"/"hesitation" despite the prompt, it is dropped here — a highlight
// is never a question, structurally enforced rather than merely requested.
const SIGNAL_TYPES = new Set(['judgment', 'objection', 'example', 'decision'])

// Extract the {signals:[...]} object from the model's reply. Tolerant of code
// fences, leaked <think> blocks, and surrounding prose. Returns null when
// nothing parseable (→ the engine retries the raw); a parsed empty array is the
// legitimate "no signals in this window".
function parseSignals(raw: string): { type: string; text: string; speaker?: string }[] | null {
  const s = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(s.slice(start, end + 1))
    const arr = obj?.signals
    if (!Array.isArray(arr)) return null
    const out: { type: string; text: string; speaker?: string }[] = []
    for (const it of arr) {
      const type = typeof it?.type === 'string' ? it.type.trim().toLowerCase() : ''
      const text = typeof it?.text === 'string' ? it.text.trim() : ''
      if (!text || !SIGNAL_TYPES.has(type)) continue
      const speaker = typeof it?.speaker === 'string' && it.speaker.trim() ? it.speaker.trim() : undefined
      out.push({ type, text, ...(speaker ? { speaker } : {}) })
    }
    return out
  } catch {
    return null
  }
}

// System prompt for the organize pass. The model groups pending signals into
// titled sections and may MERGE/REWORD unlocked lines — every item references
// its source line numbers so rewrites keep their timestamps/types client-side.
// On a normal pass the trailing (still-open) topic is left unassigned; on the
// closing pass every line must be assigned so nothing is left unorganized.
function buildOrganizeSystem(closing: boolean): string {
  return (
    `You organize a queue of meeting HIGHLIGHTS — judgments, objections, examples, decisions — ` +
    `into titled topic sections. ` +
    `The user message lists the highlights, one per numbered line (0-indexed), each tagged with its [type]; ` +
    `some carry [LOCKED] (user-edited: you may place them in a section but NEVER reword or merge them). ` +
    `You may merge redundant signals and reword wordy ones, but never invent content beyond the input lines. ` +
    `Return ONLY a JSON object of exactly this shape: ` +
    `{"sections":[{"header":"<3-6 word title>","items":[{"src":[<line numbers>],"text":"<merged/reworded text — omit this field to keep the original wording>"}]}]}. ` +
    `Sections and their items MUST follow the original line order; each line number may appear at most ONCE overall; ` +
    `never give an item containing a [LOCKED] line a "text" field. ` +
    `Write headers and rewrites in the language of the signals (Chinese signals -> Chinese header), sentence case, no punctuation in headers. ` +
    (closing
      ? `This is the FINAL pass: assign EVERY line to a section. `
      : `Leave the final, still-in-progress topic's lines UNassigned — do not section the lines still being developed. ` +
        `If no coherent grouping has emerged yet, return {"sections":[]}. `) +
    `No prose, no markdown, no code fences — output only the JSON object.`
  )
}

// Extract the {sections:[...]} object from the organize reply. Tolerant of code
// fences, leaked <think> blocks, and surrounding prose; returns [] on any doubt
// so the engine treats the round as "no organize". Index validation (range,
// reuse, locked lines) happens client-side in the engine.
function parseOrganize(raw: string): { header: string; items: { src: number[]; text?: string }[] }[] {
  const s = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const obj = JSON.parse(s.slice(start, end + 1))
    const arr = Array.isArray(obj?.sections) ? obj.sections : []
    const out: { header: string; items: { src: number[]; text?: string }[] }[] = []
    for (const sec of arr) {
      const header = typeof sec?.header === 'string' ? sec.header.trim() : ''
      const rawItems = Array.isArray(sec?.items) ? sec.items : []
      const items: { src: number[]; text?: string }[] = []
      for (const it of rawItems) {
        const src = (Array.isArray(it?.src) ? it.src : [])
          .map((n: unknown) => Math.floor(Number(n)))
          .filter((n: number) => Number.isFinite(n) && n >= 0)
        if (src.length === 0) continue
        const text = typeof it?.text === 'string' && it.text.trim() ? it.text.trim() : undefined
        items.push({ src, ...(text ? { text } : {}) })
      }
      if (header && items.length) out.push({ header, items })
    }
    return out
  } catch {
    return []
  }
}

// Stream an OpenAI-compatible chat completion as concise bullet LINES. Emits a
// completed line at a time via onText (so each bullet renders whole), strips Qwen
// <think>, and intercepts a trailing `SEARCH: <query>` / `SEARCH IMAGE: <query>`
// line — returned, not shown, so it can drive Tavily (image=true → the result
// resolves to an inline bullet image instead of a link card).
// Covers Groq / Cerebras (proxied) and local Ollama.
async function streamOpenModel(
  cfg: { base: string; key: string; model: string; proxy: boolean },
  system: string,
  userText: string,
  onText: (t: string) => void
): Promise<{ query: string; image: boolean } | undefined> {
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

  let searchQuery: { query: string; image: boolean } | undefined
  let line = '' // current (incomplete) output line

  // Decide what to do with one completed output line.
  const emitLine = (l: string) => {
    const m = l.match(/^\s*SEARCH(\s+IMAGE)?\s*:\s*(.+)$/i)
    if (m) { searchQuery = { query: m[2].trim(), image: !!m[1] }; return } // capture, don't show
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

function getReasoningParams(model: string): Record<string, string | boolean> {
  if (/qwen3\.6/i.test(model)) {
    return { reasoning_effort: 'none', include_reasoning: false }
  }
  // GPT-OSS models always reason, but Groq can hide the reasoning content.
  // Keep effort 'low': 'medium' ate the token budget (empty visible output) and
  // raised token usage into the free-tier rate limit. Marking/format quality is
  // handled by the prompt + the renderer's bold-alias instead.
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
