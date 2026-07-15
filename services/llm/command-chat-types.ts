// Tier-3 command-chat contract, shared by the browser client and the Vite
// server plugin (same pattern as cocreate-types). A command session is a chat
// panel summoned from selected canvas text; the model can propose canvas
// actions. Actions can be proposed for explicit approval or auto-applied, but
// every canvas item still lands as PENDING AI content the user must keep.
import type { CocreateProvider, OpenSub } from './cocreate-types'
import type { ProjectMemoryContext } from '../../shared-contract/project-memory'

/**
 * A canvas action proposed by the model. On the wire from the MODEL the
 * noteId is absent — the model never sees real note ids. Selection sessions
 * inject the source note id client-side; canvas sessions use session-scoped
 * aliases (n1, n1.2, …), which the client resolves through a guarded ledger.
 */
export type CommandChatAction =
  | { type: 'insert-bullet'; noteId?: string; ref?: string; text: string; apply?: boolean }
  /**
   * A visual reference. The model names a PAGE url + a caption line; the
   * server resolves the page's og:image into src. Applied client-side as a
   * pending BULLET carrying the image (never a standalone image item), so it
   * inherits ✓/✕ for free.
   */
  | { type: 'append-image'; noteId: string; src: string; sourceUrl?: string; title?: string; caption: string; apply?: boolean }
  | { type: 'add-card'; noteId?: string; ref?: string; title: string; url: string; snippet?: string; image?: string; apply?: boolean }
  | { type: 'create-note'; keyword: string; bullets: string[]; apply?: boolean }
  | { type: 'edit-bullet'; ref: string; text: string }
  | { type: 'remove-item'; ref: string }
  | { type: 'edit-note'; ref: string; keyword: string }

export type CommandChatSource =
  | { kind: 'knowledge'; id: string; title: string }
  | { kind: 'web'; title: string; url: string }

export interface CommandChatRequest {
  /** Project Memory: per-scope aiCommand instructions (appended after the base system). */
  projectInstructions?: string
  /** Project Memory: pre-assembled untrusted reference block (placed atop the prompt). */
  projectMemory?: ProjectMemoryContext
  provider: CocreateProvider
  openSub?: OpenSub
  model?: string
  /** Local runtime command/path for Codex, Claude Code, or Cursor. */
  runtimeCommand?: string
  webSearch?: boolean
  /** Full history, oldest first — the server is stateless and flattens it. */
  messages: { role: 'user' | 'assistant'; text: string }[]
  /** Recomputed by the client on EVERY turn (fresh note state each time). */
  context: {
    selectedText?: string
    /** Server echoes this into every action's noteId. */
    sourceNoteId?: string
    /** Pending canvas output created in this session, exposed only by aliases. */
    sessionCanvas?: string
    sourceNote?: {
      keyword: string
      /** Indentation preserved as leading spaces, as in cocreate. */
      humanBullets: string[]
      /** Kept AI bullets + card titles; pending suggestions excluded. */
      keptAi?: string[]
      /** Reaction signals, diagnosis-tagged as in cocreate. */
      kept?: string[]
      rejected?: string[]
    }
    /** 1 min total: originTs ±30s for dragged notes, else rolling last 60s. */
    transcriptWindow?: string
  }
}

/** NDJSON events streamed back from /api/command-chat. */
export type CommandChatEvent =
  | { type: 'text'; text: string }
  | { type: 'action'; action: CommandChatAction }
  | { type: 'source'; source: CommandChatSource }
  | { type: 'done'; model?: string; provider: CocreateProvider }
  | { type: 'error'; error: string }

export interface CommandChatResult {
  model?: string
  provider?: CocreateProvider
  error?: string
  /** True when the request was cancelled (panel closed mid-stream). */
  aborted?: boolean
}
