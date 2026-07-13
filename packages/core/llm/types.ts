// Framework-agnostic LLM domain types shared across the client-direct core.
// No Node/DOM/global assumptions live here so the module is trivially testable.

export type ProviderKind = 'openai-compatible' | 'anthropic'

// A single user-configured MaaS endpoint. Per docs module 08, the browser holds
// the key and talks to the provider directly for local-only / BYOK. When signed
// into the Go backend without a personal key, a hosted DeepSeek proxy is used
// instead (apiKey = JWT, baseUrl = `${api}/llm`, requestHeaders carry the role).
export interface LlmProvider {
  id: string // 'groq' | 'openai' | 'openrouter' | 'cerebras' | 'ollama' | 'hosted-deepseek' | 'custom'
  label: string
  baseUrl: string // e.g. https://api.groq.com/openai/v1
  apiKey: string // user-supplied, or JWT when hosted
  model: string
  kind: ProviderKind
  /** Extra headers merged into chat/stream requests (e.g. X-Thinking-Pal-Role). */
  requestHeaders?: Record<string, string>
}

// A URL reference surfaced as an inspiration card. Kept minimal and identical in
// shape to services/llm/cocreate-types so the wiring layer maps 1:1.
export interface UrlCard {
  title: string
  url: string
  snippet?: string
  image?: string
}

// The four highlight labels the extractor is allowed to keep. Questions and
// hesitations are deliberately excluded (they record flow, not judgment).
export type SignalType = 'judgment' | 'objection' | 'example' | 'decision'

export interface ExtractedSignal {
  type: SignalType
  text: string
  speaker?: string
}

export interface OrganizeItem {
  src: number[]
  text?: string
}

export interface OrganizeSection {
  header: string
  items: OrganizeItem[]
}

// Injected transport: defaults to the global fetch in browser/node, but tests
// pass a mock so no real network/key is ever needed.
export type FetchLike = typeof fetch

// The subset of reasoning-related body params some models accept.
export type ReasoningParams = Record<string, string | boolean>
