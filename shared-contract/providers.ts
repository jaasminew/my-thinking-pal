/**
 * SHARED CONTRACT — Pluggable provider interfaces (STT + LLM).
 *
 * Vendor details live behind these interfaces. Both tracks program against
 * these shapes so a provider swap (Soniox <-> Tencent, Claude <-> DeepSeek)
 * never touches UI or pipeline code. Capability flags let upstream code degrade
 * gracefully instead of crashing.
 */

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

export interface SttCapabilities {
  streaming: boolean
  diarization: boolean
  languageDetection: boolean
}

export interface SttStartOptions {
  ideaSpaceId: string
  sessionId: string
  /** absolute transcript offset to continue from (continuous timeline) */
  baseOffset: number
  language?: string
}

export type SttEvent =
  | { type: 'partial'; text: string }
  | {
      type: 'segment'
      text: string
      startMs: number
      endMs: number
      speakerId?: string
      language?: string
    }
  | { type: 'error'; message: string }

export interface SttSession {
  /** push a chunk of audio (16kHz/16-bit mono PCM unless provider says otherwise) */
  pushAudio(chunk: Uint8Array): void
  /** async stream of transcript events */
  events(): AsyncIterable<SttEvent>
  stop(): Promise<void>
}

export interface SttProvider {
  readonly id: string
  readonly capabilities: SttCapabilities
  start(options: SttStartOptions): Promise<SttSession>
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface LlmCapabilities {
  streaming: boolean
  toolCalling: boolean
  contextWindowTokens: number
  /** rough relative cost tier; used by the router for cost governance */
  costTier: 'cheap' | 'standard' | 'premium'
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface LlmToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface LlmCompleteOptions {
  messages: LlmMessage[]
  tools?: LlmToolSpec[]
  maxOutputTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; arguments: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface LlmProvider {
  readonly id: string
  readonly capabilities: LlmCapabilities
  stream(options: LlmCompleteOptions): AsyncIterable<LlmEvent>
}
