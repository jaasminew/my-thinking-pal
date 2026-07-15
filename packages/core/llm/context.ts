// Pure context-engineering helpers: turn structured note/transcript/signal data
// into the single user-message string each pass expects. No transport, no I/O.

// Project-memory reference block: placed FIRST in the user message — before
// transcript, signals, and note context — and already framed as untrusted
// reference data by the retrieval layer (never instructions to obey).
export function prependMemoryBlock(userText: string, block?: string): string {
  const b = block?.trim()
  return b ? `${b}\n\n${userText}` : userText
}

export interface CocreateSignals {
  kept?: string[]
  rejected?: string[]
  existingIdeas?: string[]
}

// Tier-2: the seed idea + nearby canvas notes + the transcript window it came
// from. Deliberately small — this is the "what to send" knob.
export function buildCocreateContext(
  seedText: string,
  contextNotes?: string[],
  transcriptWindow?: string,
  signals?: CocreateSignals,
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
export function buildCommandContext(
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

export interface CommandChatMessage {
  role: string
  text: string
}

export interface CommandChatContext {
  transcriptWindow?: string
  selectedText?: string
  sourceNoteId?: string
  sessionCanvas?: string
  sourceNote?: {
    keyword?: string
    humanBullets?: string[]
    keptAi?: string[]
    kept?: string[]
    rejected?: string[]
  }
}

// Flatten the full chat history + this turn's context into ONE prompt (the
// backends are stateless one-shot calls — this replay IS the session memory).
export function buildCommandChatPrompt(
  messages: CommandChatMessage[],
  context?: CommandChatContext
): string {
  const parts: string[] = []
  if (typeof context?.transcriptWindow === 'string' && context.transcriptWindow.trim()) {
    const label = context?.sourceNote
      ? 'Spoken transcript around this note (1 min):'
      : 'Spoken transcript (last 1 min):'
    parts.push(`${label}\n${context.transcriptWindow.trim()}`)
  }
  const sn = context?.sourceNote
  if (sn && typeof sn === 'object') {
    const lines: string[] = [`Keyword: ${sn.keyword || '(untitled)'}`]
    if (Array.isArray(sn.humanBullets) && sn.humanBullets.length) {
      lines.push(
        `The user's bullets (indented lines are sub-points):\n${sn.humanBullets.map((t) => `- ${t}`).join('\n')}`
      )
    }
    if (Array.isArray(sn.keptAi) && sn.keptAi.length) {
      lines.push(`AI contributions the user already KEPT:\n${sn.keptAi.map((t) => `- ${t}`).join('\n')}`)
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
  if (!context?.sourceNote && !context?.selectedText?.trim()) {
    parts.push('The user summoned you from the open canvas — no note is selected.')
  }
  if (typeof context?.sessionCanvas === 'string' && context.sessionCanvas.trim()) {
    parts.push(
      `Canvas content YOU created this session (alias-addressed; the only canvas content you may edit):\n` +
        context.sessionCanvas.trim()
    )
  }
  const hist = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${String(m.text ?? '')}`)
    .join('\n\n')
  parts.push(`Conversation so far:\n${hist}\n\nRespond to the last user message now.`)
  return parts.join('\n\n')
}

// Signal-extraction user message: prior signals as context + the new raw window.
export function buildExtractSignalsUserText(rawText: string, existingSignals?: string): string {
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
