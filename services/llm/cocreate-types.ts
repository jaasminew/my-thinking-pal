// Tier-2 co-creation + Tier-3 command contract. Same module the integrated demo
// imports — the UI never talks to a model directly; it calls /api/cocreate, which
// routes to one of three SWITCHABLE backends and (optionally) searches the web.
//
//   provider 'claude-code' → spawns the `claude` CLI (your Claude subscription,
//                            no API key). WebSearch is built in.
//   provider 'codex'       → spawns the `codex` CLI (your ChatGPT subscription).
//   provider 'open'        → an OpenAI-compatible open model (Groq/Cerebras/Ollama)
//                            + Tavily for the inspiration URLs.
export type CocreateProvider = 'claude-code' | 'codex' | 'open'
export type OpenSub = 'groq' | 'cerebras' | 'ollama'

export interface CocreateRequest {
  /** The human-origin seed: a typed rough idea or a dragged transcript phrase. */
  seedText: string
  /** Nearby canvas notes (human + AI) sent as context. Keep it small. */
  contextNotes?: string[]
  /** Recent transcript window, when the seed came from the transcript. */
  transcriptWindow?: string
  /** Reaction signals — AI suggestions the user KEPT (positive) / REJECTED (negative). */
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
}
