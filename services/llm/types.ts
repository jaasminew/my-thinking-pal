// The kind of highlight a kept statement is — a LABEL attached after the
// quality filter selects it, not a target the extractor fishes for. Questions
// and hesitations are deliberately excluded: they record the flow of a
// conversation rather than changing how the reader thinks, so they are never
// highlights. Recorded on every line (and fed to co-creation as
// personalization context) but never rendered — the transcript UI is plain text.
export type SignalType = 'judgment' | 'objection' | 'example' | 'decision'

// ---- Signal extraction (every ~2min) ----------------------------------------
export interface ExtractSignalsRequest {
  systemPrompt: string
  /** Raw STT text captured since the previous window, with [S1]/[S2] speaker tags. */
  rawText: string
  /** Already-extracted pending signals. Context only — do not re-emit (unless a type upgrades). */
  existingSignals?: string
  /** 'groq' | 'cerebras' */
  provider: string
  /** Optional model id to override the provider's .env default (Groq picker). */
  model?: string
}

export interface ExtractedSignal {
  type: SignalType
  /** One complete written-style statement. */
  text: string
  /** Speaker tag ('S1', 'S2', …) when the raw carried diarization. */
  speaker?: string
}

export interface ExtractSignalsResult {
  signals: ExtractedSignal[]
  /**
   * True when the model produced no PARSEABLE output — the engine puts the raw
   * back and retries. A parsed empty `signals` list is the opposite: a real
   * "nothing signal-worthy here", and the raw window is discarded.
   */
  skipped?: boolean
  /** Server-measured round-trip to the model, ms. */
  serverMs: number
  model?: string
  error?: string
}

// ---- Organize (every ~5min + on stop) ---------------------------------------
export interface OrganizeRequest {
  /**
   * The pending signals as numbered lines: `0 [judgment]: ...`. User-edited
   * lines carry [LOCKED] — the model may regroup but never reword them.
   */
  lines: string
  /** Final pass on stop: assign every line so nothing is left unorganized. */
  closing?: boolean
  /** 'groq' | 'cerebras' | 'claude-code' | 'codex' — the CLI backends run the
   *  organize pass on the user's subscription; Groq uses `model`. */
  provider: string
  /** Optional model id (Groq only); organizing uses a thinking model. */
  model?: string
}

export interface OrganizeItem {
  /** Input line numbers this item covers (a single line, or several merged). */
  src: number[]
  /** Rewritten/merged text; omitted = keep the source line's wording. */
  text?: string
}

export interface OrganizeSection {
  /** 3-6 word title. */
  header: string
  items: OrganizeItem[]
}

export interface OrganizeResult {
  sections: OrganizeSection[]
  serverMs: number
  model?: string
  error?: string
}

export interface SectionHeaderRequest {
  /** The finished section's cleaned body to title. */
  body: string
  /** 'groq' | 'cerebras' */
  provider: string
  /** Optional model id to override the provider's .env default (Groq picker). */
  model?: string
}

export interface SectionHeaderResult {
  /** Short 3-6 word title for the section. */
  header: string
  serverMs: number
  model?: string
  error?: string
}
