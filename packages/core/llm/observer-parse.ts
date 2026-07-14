// Structured-output parsers for the observer evaluator and contributor.
//
// Both are pure, never-throw functions: model output is junk-tolerant and the
// engine treats `null` as "skip this round". JSON may arrive fenced in markdown
// or surrounded by prose; the evaluator parser extracts the first balanced
// `{...}` block. The contributor parser speaks a small line protocol.
//
// Wire formats for evaluator/contributor model output.

import type { ObserverDecision, ObserverContribution, ObserverOpportunityType } from './observer-types'

// The seven opportunity types the evaluator may emit (frozen in observer-types).
const OPPORTUNITY_TYPES = new Set<ObserverOpportunityType>([
  'missing-angle',
  'connection',
  'comparison',
  'risk',
  'example',
  'question',
  'source'
])

// Extract the first balanced {...} block from text that may contain prose or
// markdown fences. Braces inside JSON string literals don't count toward depth.
// Returns null when no balanced block is found.
function extractFirstBalancedJson(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
    } else {
      if (ch === '"') {
        inString = true
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) return s.slice(start, i + 1)
      }
    }
  }
  return null // unbalanced — no complete JSON object
}

// Parse the evaluator's JSON reply into an ObserverDecision, or null when
// malformed. Never throws. See contract §1.1 for the parse rules.
export function parseObserverDecision(content: string): ObserverDecision | null {
  // Strip markdown fences; the JSON may still be surrounded by prose.
  const stripped = content
    .replace(/```json/gi, '')
    .replace(/```/g, '')
  const jsonStr = extractFirstBalancedJson(stripped)
  if (!jsonStr) return null

  let obj: unknown
  try {
    obj = JSON.parse(jsonStr)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null

  const o = obj as Record<string, unknown>

  // emit must be a boolean — missing or non-boolean is malformed.
  if (typeof o.emit !== 'boolean') return null

  // confidence: non-numeric or absent → default 0.
  const confidence =
    typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : 0

  if (!o.emit) {
    // emit:false — all other fields optional; return the minimal shape.
    return { emit: false, confidence }
  }

  // emit:true — opportunityType and topic are required and must be valid.
  const opportunityType = o.opportunityType
  if (
    typeof opportunityType !== 'string' ||
    !OPPORTUNITY_TYPES.has(opportunityType as ObserverOpportunityType)
  ) {
    return null
  }
  const topic = typeof o.topic === 'string' ? o.topic.trim() : ''
  if (!topic) return null

  const decision: ObserverDecision = {
    emit: true,
    confidence,
    opportunityType: opportunityType as ObserverOpportunityType,
    topic
  }

  if (typeof o.reason === 'string' && o.reason.trim()) {
    decision.reason = o.reason
  }

  // needsResearch defaults false; only true when explicitly true.
  decision.needsResearch = o.needsResearch === true

  // suggestedSearchQuery kept only when a non-empty string.
  if (
    typeof o.suggestedSearchQuery === 'string' &&
    o.suggestedSearchQuery.trim()
  ) {
    decision.suggestedSearchQuery = o.suggestedSearchQuery
  }

  return decision
}

// Parse the contributor's plain-text reply into an ObserverContribution, or
// null when malformed. Never throws. See contract §1.2 for the wire format:
//
//   KEYWORD: <topic>
//   - bullet one
//   - bullet two
//   SEARCH: <optional query>
export function parseObserverContribution(content: string): ObserverContribution | null {
  const lines = content.split(/\r?\n/)

  // KEYWORD: line is required (case-insensitive). First occurrence wins.
  let keyword = ''
  let keywordIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    // Tolerate harmless Markdown emphasis even though the prompt requests
    // plain text. Several OpenAI-compatible models emit **KEYWORD:**.
    const match = trimmed.match(
      /^(?:\*\*|__)?keyword(?:(?:\*\*|__)\s*:|\s*:\s*(?:\*\*|__)?)\s*(.*)$/i
    )
    if (match) {
      keyword = match[1].trim()
      keywordIdx = i
      break
    }
  }
  if (keywordIdx < 0 || !keyword) return null

  const bullets: string[] = []
  let searchQuery: string | undefined
  let searchFound = false

  for (let i = keywordIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()

    // SEARCH: line — first occurrence wins; empty query is ignored (not stored).
    const searchMatch = trimmed.match(
      /^(?:\*\*|__)?search(?:(?:\*\*|__)\s*:|\s*:\s*(?:\*\*|__)?)\s*(.*)$/i
    )
    if (!searchFound && searchMatch) {
      searchFound = true
      const q = searchMatch[1].trim()
      if (q) searchQuery = q
      continue
    }

    // Accept the requested '-' plus common model variants '*' and Unicode '•'.
    // Cap at 3 (keep first, drop rest).
    if (/^[-*•]/.test(trimmed)) {
      if (bullets.length < 3) {
        bullets.push(trimmed.slice(1).trim())
      }
    }
    // All other lines ignored.
  }

  if (bullets.length === 0) return null

  const result: ObserverContribution = { keyword, bullets }
  if (searchQuery) result.searchQuery = searchQuery
  return result
}
