// Pure parsing/normalization helpers for model replies. All tolerant of code
// fences, leaked <think> blocks, and surrounding prose. No transport.

import type { ExtractedSignal, OrganizeSection, ReasoningParams, SignalType } from './types'

// Backstop: only these four labels survive. A highlight is never a question,
// enforced structurally rather than merely requested in the prompt.
export const SIGNAL_TYPES = new Set<SignalType>(['judgment', 'objection', 'example', 'decision'])

// Extract the {signals:[...]} object. Returns null when nothing parseable (→ the
// engine retries the raw); a parsed empty array is the legitimate "no signals".
export function parseSignals(raw: string): ExtractedSignal[] | null {
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
    const out: ExtractedSignal[] = []
    for (const it of arr) {
      const type = typeof it?.type === 'string' ? it.type.trim().toLowerCase() : ''
      const text = typeof it?.text === 'string' ? it.text.trim() : ''
      if (!text || !SIGNAL_TYPES.has(type as SignalType)) continue
      const speaker = typeof it?.speaker === 'string' && it.speaker.trim() ? it.speaker.trim() : undefined
      out.push({ type: type as SignalType, text, ...(speaker ? { speaker } : {}) })
    }
    return out
  } catch {
    return null
  }
}

// Extract the {sections:[...]} object; returns [] on any doubt so the engine
// treats the round as "no organize". Index validation happens in the engine.
export function parseOrganize(raw: string): OrganizeSection[] {
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
    const out: OrganizeSection[] = []
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

// Model-specific reasoning params for OpenAI-compatible bodies.
export function getReasoningParams(model: string): ReasoningParams {
  if (/qwen3\.6/i.test(model)) {
    return { reasoning_effort: 'none', include_reasoning: false }
  }
  // GPT-OSS models always reason, but Groq can hide the reasoning content. Keep
  // effort 'low' (medium ate the token budget and hit the free-tier limit).
  if (/gpt-oss/i.test(model)) {
    return { reasoning_effort: 'low', reasoning_format: 'hidden' }
  }
  return {}
}

// Reasoning params for the JSON-answer passes (extract/organize): gpt-oss needs
// medium effort + hidden reasoning so the JSON isn't starved; others fall back.
export function getJsonReasoningParams(model: string): ReasoningParams {
  if (/gpt-oss/i.test(model)) {
    return { reasoning_effort: 'medium', reasoning_format: 'hidden' }
  }
  // Native DeepSeek's OpenAI-compatible endpoint does not accept the
  // Groq/OpenRouter reasoning_effort/include_reasoning extensions. Omitting
  // them avoids a 400; the larger JSON-pass token budget provides headroom.
  if (/deepseek/i.test(model)) {
    return {}
  }
  return getReasoningParams(model)
}

// Strip reasoning leakage from a short free-text reply (e.g. a section title).
// Returns '' when the reply is all/broken reasoning, so callers can skip it.
export function sanitizeCleanedTranscript(raw: string): string {
  let s = raw.replace(/```[\s\S]*?```/g, '').trim()

  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const openThink = s.search(/<think>/i)
  if (openThink >= 0) {
    const close = s.search(/<\/think>/i)
    if (close < 0 || close < openThink) return ''
    s = (s.slice(0, openThink) + s.slice(close + '</think>'.length)).trim()
  }

  const leakedReasoning =
    /thinking process|analy[sz]e user input|identify key elements|draft generation|constraints/i.test(s)
  if (leakedReasoning) return ''

  return s
}

// Normalize a raw section-header reply into a clean title.
export function cleanSectionHeader(raw: string): string {
  return sanitizeCleanedTranscript(raw)
    .replace(/^[-*#>\s]+/, '')
    .replace(/["'“”]/g, '')
    .trim()
}
