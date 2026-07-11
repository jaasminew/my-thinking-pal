// Shared sandbox engine: the ONE path from case data → real prompt → real Codex
// call → real parsers → parsed reply. Both the CLI runner (run.ts) and the web
// server (server.ts) import this, so they can never drift apart.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COCREATE_SYSTEM, SEARCH_INSTRUCTION } from '../../packages/core/llm/cocreate-prompt'
import { buildCocreateContext } from '../../packages/core/llm/context'
import { makeLinkStripper, makeProtocolFilter } from '../../packages/core/llm/filters'

export const DEFAULT_MODEL = 'gpt-5.6-terra'
const TIMEOUT_MS = 300_000

export { COCREATE_SYSTEM, SEARCH_INSTRUCTION }

/** The editable half of a session — everything the user fills in on the right pane. */
export interface CaseInput {
  seedText: string
  seedType?: string
  contextNotes?: string[]
  transcriptWindow?: string
  signalWindow?: string
  kept?: string[]
  rejected?: string[]
  existingIdeas?: string[]
  webSearch?: boolean
}

export interface ParsedReply {
  diagnosis: string
  anchor: number | null
  passed: boolean
  bullets: string[]
  search?: { query: string; image: boolean }
  urls: { title: string; url: string }[]
}

/** The full system prompt sent for a given case (base + optional search block). */
export function systemFor(input: Pick<CaseInput, 'webSearch'>): string {
  return COCREATE_SYSTEM + (input.webSearch ? SEARCH_INSTRUCTION : '')
}

/** The exact user message the app would assemble for this case. */
export function userTextFor(input: CaseInput): string {
  return buildCocreateContext(
    input.seedText,
    input.contextNotes,
    input.transcriptWindow,
    { kept: input.kept, rejected: input.rejected, existingIdeas: input.existingIdeas },
    input.signalWindow,
    input.seedType
  )
}

// Interpret a full reply with the app's own filters (protocol + link stripper),
// plus the SEARCH-line capture the streaming path does in stream.ts.
export function parseReply(raw: string): ParsedReply {
  const out: ParsedReply = { diagnosis: '', anchor: null, passed: false, bullets: [], urls: [] }
  let lineBuf = ''
  const strip = makeLinkStripper(
    (t) => {
      lineBuf += t
      let i: number
      while ((i = lineBuf.indexOf('\n')) >= 0) {
        const l = lineBuf.slice(0, i).trim()
        if (l) out.bullets.push(l)
        lineBuf = lineBuf.slice(i + 1)
      }
    },
    (u) => out.urls.push(u),
    (im) => out.urls.push({ title: `[inline image] ${im.title}`, url: im.url })
  )
  const proto = makeProtocolFilter(
    (l) => {
      const m = l.match(/^\s*SEARCH(\s+IMAGE)?\s*:\s*(.+)$/i)
      if (m) {
        out.search = { query: m[2].trim(), image: !!m[1] }
        return
      }
      strip.push(l)
    },
    (d) => {
      out.diagnosis = d
    },
    (a) => {
      out.anchor = a
    }
  )
  proto.push(raw.endsWith('\n') ? raw : raw + '\n')
  proto.flush()
  strip.flush()
  if (lineBuf.trim()) out.bullets.push(lineBuf.trim())
  out.passed = proto.passed
  return out
}

// Mirror of apps/desktop/main.cjs runCodex: same subcommand, flags, and combined
// system+user prompt text. Only the cwd differs — a neutral temp dir instead of
// the repo, so repo files can't leak into suggestions.
export function callCodex(model: string, system: string, userText: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocreate-sandbox-'))
  const outFile = path.join(dir, 'last-message.txt')
  const cmd = path.join(process.cwd(), 'node_modules', '.bin', 'codex')
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '-C',
    dir,
    '--output-last-message',
    outFile,
    '--model',
    model,
    `System instructions:\n${system}\n\nUser/context:\n${userText}`
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`codex timed out after ${TIMEOUT_MS / 1000}s`))
    }, TIMEOUT_MS)
    child.stdout.on('data', (d) => (stdout += String(d)))
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let text = ''
      try {
        text = fs.readFileSync(outFile, 'utf8')
      } catch {
        text = stdout
      }
      fs.rmSync(dir, { recursive: true, force: true })
      if (code !== 0 && !text.trim()) reject(new Error((stderr || stdout).trim().slice(0, 800) || `codex exited ${code}`))
      else resolve(text.trim() || stdout.trim())
    })
  })
}

export interface RunResult {
  parsed?: ParsedReply
  raw: string
  userText: string
  system: string
  error?: string
  ms: number
}

/** Full round: case input → parsed reply. Never throws; errors ride in RunResult. */
export async function runOnce(input: CaseInput, model = DEFAULT_MODEL): Promise<RunResult> {
  const system = systemFor(input)
  const userText = userTextFor(input)
  const t0 = Date.now()
  try {
    const raw = await callCodex(model, system, userText)
    return { parsed: parseReply(raw), raw, userText, system, ms: Date.now() - t0 }
  } catch (e: any) {
    return { raw: '', userText, system, error: e?.message || String(e), ms: Date.now() - t0 }
  }
}
