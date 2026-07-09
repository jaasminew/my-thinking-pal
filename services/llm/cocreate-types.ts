// Tier-2 co-creation + Tier-3 command contract. Same module the integrated demo
// imports — the UI never talks to a model directly; it calls /api/cocreate, which
// routes to one of three SWITCHABLE backends and (optionally) searches the web.
//
//   provider 'claude-code' → spawns the `claude` CLI (your Claude subscription,
//                            no API key). WebSearch is built in.
//   provider 'codex'       → spawns the `codex` CLI (your ChatGPT subscription).
//   provider 'open'        → an OpenAI-compatible open model (Groq/Cerebras/Ollama)
//                            + Tavily for the inspiration URLs.
export type CocreateProvider = 'claude-code' | 'codex' | 'cursor' | 'open'
export type OpenSub = string

export interface CocreateRequest {
  /** The human-origin seed: a typed rough idea or a dragged transcript phrase. */
  seedText: string
  /** Nearby canvas notes (human + AI) sent as context. Keep it small. */
  contextNotes?: string[]
  /**
   * Verbatim word-by-word transcript window (never the cleaned summary):
   * ±1min around when a dragged keyword was spoken, or the rolling last 2min
   * for other notes. Omitted entirely when nothing was recorded.
   */
  transcriptWindow?: string
  /**
   * Typed pending signals extracted from the same window, one per line as
   * "[decision] …" / "[objection] …" (speaker-prefixed when diarized). The
   * user never sees these tags — they let the model weight its contribution
   * by what KIND of thought it is responding to.
   */
  signalWindow?: string
  /**
   * When the seed is a phrase dragged from the transcript, the signal type of
   * the line it came from ('decision', 'objection', …).
   */
  seedType?: string
  /**
   * Reaction signals — AI suggestions the user KEPT (positive) / REJECTED
   * (negative). Each entry may carry the fire's diagnosis inline, e.g.
   * "Notion stores… [offered because: bullet 2 needs a real case]", so the
   * model learns WHICH KINDS of help land, not just which texts.
   */
  kept?: string[]
  rejected?: string[]
  /** Everything already on the canvas (human + AI bullets, card titles) — do not repeat. */
  existingIdeas?: string[]
  /** Which backend to route to. */
  provider: CocreateProvider
  /** For provider 'open': which OpenAI-compatible host. Default 'groq'. */
  openSub?: OpenSub
  /** Optional explicit model id override (open-model picker). */
  model?: string
  /** Local runtime command/path for Codex, Claude Code, or Cursor. */
  runtimeCommand?: string
  /** Tier-2 toggle: let the model search the web for inspiration URLs. */
  webSearch?: boolean
  /**
   * Tier-3 command-box text. When set, this is an explicit command ("go search
   * some voice-to-text products") rather than an ambient build-on of seedText.
   */
  command?: string
}

/** One web-search result → renders as an inspiration URL card on the canvas. */
export interface UrlCard {
  title: string
  url: string
  snippet?: string
  image?: string
}

/** NDJSON events streamed back from /api/cocreate, one JSON object per line. */
export type CocreateEvent =
  | { type: 'text'; text: string }
  /**
   * The model's self-diagnosis of what the note needs most right now — emitted
   * BEFORE any content. Machine-only: never rendered, but attached to the
   * suggestions it produced so kept/rejected reactions carry the WHY.
   */
  | { type: 'diagnosis'; text: string }
  /**
   * Which of the user's bullets this fire builds on (index into the numbered
   * contextNotes list) — emitted before any text. Machine-only: the client
   * uses it to place the fire's bullets as sub-points under that thought
   * instead of appending them after the whole note. Absent = note-level.
   */
  | { type: 'anchor'; line: number }
  /**
   * An inline image belonging to ONE bullet (the model chose the words+image
   * register). src is the cited page's own og:image; line is the 0-based
   * content-line index of the bullet it belongs to.
   */
  | { type: 'image'; src: string; sourceUrl?: string; title?: string; line?: number }
  | { type: 'urls'; urls: UrlCard[] }
  | { type: 'done'; model?: string; provider: CocreateProvider }
  | { type: 'error'; error: string }

export interface CocreateResult {
  /** Resolved model/agent id the backend actually used. */
  model?: string
  provider?: CocreateProvider
  /** Inspiration URLs found via web search (empty if none / search off). */
  urls?: UrlCard[]
  error?: string
  /** True when the request was cancelled (e.g. AI mode switched off mid-stream). */
  aborted?: boolean
}
