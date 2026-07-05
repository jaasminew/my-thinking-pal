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
  /** Cleaned transcript: concise written-style idea lines (one idea per line). */
  markedText: string
  /** True when the model had no usable output for this window (skipped, not an error). */
  skipped?: boolean
  /** Server-measured round-trip to the model, ms. */
  serverMs: number
  model?: string
  error?: string
}

// ---- Segmentation (structuring pass) ---------------------------------------
export interface SegmentRequest {
  /** The open tail as numbered lines, "0: ...\n1: ...\n2: ...". Frozen sections are NOT sent. */
  lines: string
  /** Final pass on stop: cover every line so the trailing segment is titled too. */
  closing?: boolean
  /** 'groq' | 'cerebras' */
  provider: string
  /** Optional model id (Groq picker); segmentation uses a thinking model. */
  model?: string
}

export interface SegmentSection {
  /** Inclusive last line index of a closed section. */
  endLine: number
  /** 3-6 word title for the closed section. */
  header: string
}

export interface SegmentResult {
  sections: SegmentSection[]
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
