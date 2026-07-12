// Observer evaluator + contributor prompts (feature: docs/observer/…). Pure
// constants/builders, no transport — snapshot-testable like prompts.ts. The
// evaluator decides WHETHER the discussion would benefit from an intervention
// (contract §1.1 JSON); the contributor writes the note once a decision passed
// the deterministic gates (contract §1.2 plain-text protocol).
//
// Design priorities (lead-plan §3.1/§3.2): precision over activity, silence is a
// normal successful output, never summarize/restate, respect rejected topics,
// and factual claims must ask for research rather than being asserted.

import type { ObserverContributorInput, ObserverEvaluatorInput, ObserverSignal } from './observer-types'

/** Bullet cap, mirrored from contract §4 (kept local to avoid a cross-import). */
const MAX_BULLETS = 3

// The seven opportunity kinds, spelled out for the model (mirror
// ObserverOpportunityType). Kept as a string so the prompt reads naturally.
const OPPORTUNITY_TYPES = 'missing-angle | connection | comparison | risk | example | question | source'

// ---- Evaluator --------------------------------------------------------------

export function buildObserverEvaluatorSystem(): string {
  return (
    `You are a SILENT observer of a live thinking session. People are talking; their speech has ` +
    `been distilled into typed "signals" (judgments, objections, examples, decisions). You are shown ` +
    `a fresh batch of signals and asked ONE question: would the discussion genuinely benefit right now ` +
    `from a new angle the group has NOT yet considered?\n\n` +
    `Your default answer is NO. Silence is a correct, successful output — most batches deserve it. ` +
    `Emit ONLY when you can name a specific, non-obvious contribution that adds value. Do NOT emit for: ` +
    `small talk or logistics; a summary or restatement of what was said; generic advice; a weak or ` +
    `strained association; or an unfinished thought still being worked out.\n\n` +
    `Before emitting, CHECK the fresh signals against the existing canvas summary, the list of recent ` +
    `observer topics, and the list of rejected suggestions. If your idea overlaps any of them, do not ` +
    `emit — the group has already seen it or turned it down. False positives cost far more than silence.\n\n` +
    `If your contribution would rest on a factual claim — a product, statistic, comparison, case study, ` +
    `or anything verifiable — set "needsResearch": true and give a concise "suggestedSearchQuery". ` +
    `Purely conceptual contributions (a connection, a risk, a question) need no research.\n\n` +
    `Return ONLY one JSON object of exactly this shape (no prose, no markdown, no code fences):\n` +
    `{"emit":<true|false>,"confidence":<0..1>,"opportunityType":"<${OPPORTUNITY_TYPES}>",` +
    `"topic":"<short phrase naming the angle>","reason":"<one sentence: why this adds value now>",` +
    `"needsResearch":<true|false>,"suggestedSearchQuery":<"<query>"|null>}.\n` +
    `When "emit" is false, return just {"emit":false,"confidence":<0..1>} — omit the other fields. ` +
    `When "emit" is true, "opportunityType" and "topic" are REQUIRED. ` +
    `"confidence" is your own 0-1 estimate. Write "topic" and "reason" in the dominant language of the ` +
    `conversation; never translate the discussion into another language.\n\n` +
    `Examples (input → output):\n` +
    `— Signals: "[judgment] let's grab lunch after this", "[example] the coffee machine is broken again" → ` +
    `{"emit":false,"confidence":0.05}\n` +
    `— Signals restate a rejected topic (rejected list contains "use Redis for caching") and the group ` +
    `just said "[decision] we'll cache with Redis" → {"emit":false,"confidence":0.2}\n` +
    `— Signals: "[decision] we'll sync notes across devices with a local database", "[objection] but what ` +
    `if two people edit offline?" and the canvas never mentions conflict handling → ` +
    `{"emit":true,"confidence":0.8,"opportunityType":"missing-angle","topic":"offline edit conflicts",` +
    `"reason":"the group chose local-first sync but has not addressed how conflicting offline edits merge",` +
    `"needsResearch":true,"suggestedSearchQuery":"crdt vs last-write-wins offline sync conflict resolution"}`
  )
}

export function buildObserverEvaluatorUserText(input: ObserverEvaluatorInput): string {
  const parts: string[] = []
  parts.push(
    `Fresh signals that just triggered this evaluation (the newest development — judge THESE):\n` +
      renderSignals(input.signals)
  )
  if (input.transcriptWindow && input.transcriptWindow.trim()) {
    parts.push(`Verbatim transcript, last ~5 minutes (context):\n${input.transcriptWindow.trim()}`)
  }
  if (input.canvasSummary && input.canvasSummary.trim()) {
    parts.push(
      `Already on the canvas — existing note titles and settled content (do NOT re-propose any of this):\n` +
        input.canvasSummary.trim()
    )
  }
  const recent = input.recentObserverTopics?.filter(Boolean)
  if (recent?.length) {
    parts.push(
      `Topics you (the observer) recently raised — do NOT repeat or lightly reword these:\n- ${recent.join('\n- ')}`
    )
  }
  const kept = input.kept?.filter(Boolean)
  if (kept?.length) parts.push(`Suggestions the user KEPT (the kind of value that lands):\n- ${kept.join('\n- ')}`)
  const rejected = input.rejected?.filter(Boolean)
  if (rejected?.length) {
    parts.push(`Suggestions the user REJECTED (do NOT go back to these directions):\n- ${rejected.join('\n- ')}`)
  }
  if (input.dominantLanguage) {
    parts.push(`Dominant language of the conversation: ${input.dominantLanguage} (write topic/reason in it).`)
  }
  parts.push(`Decide now. Respond with the single JSON object only.`)
  return parts.join('\n\n')
}

// ---- Contributor ------------------------------------------------------------

export function buildObserverContributorSystem(): string {
  return (
    `You are a thoughtful participant in a live thinking session. An evaluator already decided this moment ` +
    `deserves a new angle and told you WHICH angle. Your job is to write it as a short, self-contained note ` +
    `the group can keep or reject.\n\n` +
    `Contribute a genuinely NEW angle — a connection, missing consideration, risk, comparison, example, or ` +
    `question the group has not raised. Never summarize or restate the transcript or what is already on the ` +
    `canvas. Be concrete and specific; one sharp point beats three vague ones.\n\n` +
    `Output EXACTLY this plain-text format and nothing else:\n` +
    `KEYWORD: <a title of at most 5 words>\n` +
    `- <bullet: one concrete new point>\n` +
    `- <bullet>\n` +
    `(1 to ${MAX_BULLETS} bullets, each starting with "- "; no bullet may merely repeat the transcript)\n` +
    `Then, ONLY if the brief says research is needed, a final line:\n` +
    `SEARCH: <a focused web-search query>\n\n` +
    `Rules: no preamble, no closing remarks, no headings other than KEYWORD. Do NOT put URLs or a "Sources" ` +
    `list in the bullets — sources are attached separately by the app from the search path. Add the SEARCH ` +
    `line only when told research is needed; otherwise omit it entirely. Write everything in the dominant ` +
    `language of the conversation.`
  )
}

export function buildObserverContributorUserText(input: ObserverContributorInput): string {
  const parts: string[] = []
  const d = input.decision
  const brief: string[] = []
  if (d.opportunityType) brief.push(`Kind of contribution: ${d.opportunityType}`)
  if (d.topic) brief.push(`Angle to develop: ${d.topic}`)
  if (d.reason) brief.push(`Why it matters here: ${d.reason}`)
  brief.push(d.needsResearch ? `Research: NEEDED — end with a SEARCH: line.` : `Research: not needed — no SEARCH line.`)
  parts.push(`Your brief (from the evaluator):\n${brief.join('\n')}`)

  parts.push(`Signals from the conversation that prompted this:\n${renderSignals(input.signals)}`)
  if (input.transcriptWindow && input.transcriptWindow.trim()) {
    parts.push(`Verbatim transcript, last ~5 minutes (context):\n${input.transcriptWindow.trim()}`)
  }
  if (input.canvasSummary && input.canvasSummary.trim()) {
    parts.push(
      `Already on the canvas (do NOT restate; your bullets must add something new):\n${input.canvasSummary.trim()}`
    )
  }
  if (input.dominantLanguage) {
    parts.push(`Dominant language of the conversation: ${input.dominantLanguage} (write the note in it).`)
  }
  parts.push(`Write the note now, in the exact KEYWORD / bullet format.`)
  return parts.join('\n\n')
}

// ---- Shared -----------------------------------------------------------------

// Render signals for a prompt: [type] optionally "S1:" speaker, then text. The
// type tags help the model weigh what kind of contribution fits, exactly as in
// co-creation context; the user never sees them.
function renderSignals(signals: ObserverSignal[]): string {
  const lines = (Array.isArray(signals) ? signals : [])
    .map((s) => {
      const text = (s?.text || '').trim()
      if (!text) return ''
      const type = s.type ? `[${s.type}] ` : ''
      const who = s.speaker ? `${s.speaker}: ` : ''
      return `- ${type}${who}${text}`
    })
    .filter(Boolean)
  return lines.length ? lines.join('\n') : '(no signals)'
}
