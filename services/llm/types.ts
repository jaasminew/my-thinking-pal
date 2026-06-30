export interface HighlightRequest {
  systemPrompt: string
  /** Recent transcript window to scan for highlights. */
  text: string
  /** 'groq' | 'cerebras' */
  provider: string
  /** Optional model id to override the provider's .env default (Groq picker). */
  model?: string
}

export interface HighlightResult {
  phrases: string[]
  /** Server-measured round-trip to the model, ms. */
  serverMs: number
  model?: string
  error?: string
}

export interface CleanTranscriptRequest {
  systemPrompt: string
  /** Raw STT text captured since the previous pause. Never resend earlier raw text. */
  rawText: string
  /** Already-rendered cleaned notes. This is context only; raw STT is not resent. */
  existingNotes?: string
  /** 'groq' | 'cerebras' */
  provider: string
  /** Optional model id to override the provider's .env default (Groq picker). */
  model?: string
}

export interface CleanTranscriptResult {
  /** Cleaned transcript with highlights marked as ==phrase==. */
  markedText: string
  /** Server-measured round-trip to the model, ms. */
  serverMs: number
  model?: string
  error?: string
}
