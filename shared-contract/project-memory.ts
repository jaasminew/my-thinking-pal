/**
 * SHARED CONTRACT — Project Memory wire types.
 *
 * These are the transport-neutral shapes shared by the web UI, the retrieval
 * layer, and the Go backend's JSON. Browser-only interfaces (IndexedDB store,
 * fetch client, React props/hook) live in `services/project-memory/types.ts`,
 * which re-exports everything here.
 *
 * Design (see PROJECT_MEMORY_LEAD_PLAN.md): the server is a dumb store — it
 * never calls AI and never holds an API key. Title/description generation and
 * file selection run in the browser with the user's own provider settings.
 */

// ---------------------------------------------------------------------------
// Scope: which memory bucket a canvas reads. The sidebar tree is client-owned
// JSON; a canvas inside a project resolves to that project's scope, otherwise
// to its own space scope.
// ---------------------------------------------------------------------------

export type ProjectMemoryScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'space'; spaceId: string }

export type ProjectMemoryScopeKind = ProjectMemoryScope['kind']

/** Flat (kind, id) pair — the form routes and storage keys use. */
export function scopeKey(scope: ProjectMemoryScope): { scopeKind: ProjectMemoryScopeKind; scopeId: string } {
  return scope.kind === 'project'
    ? { scopeKind: 'project', scopeId: scope.projectId }
    : { scopeKind: 'space', scopeId: scope.spaceId }
}

// ---------------------------------------------------------------------------
// Files & instructions
// ---------------------------------------------------------------------------

export type ProjectMemoryFileStatus = 'queued' | 'extracting' | 'indexed' | 'failed'

export type ProjectMemoryFile = {
  id: string
  scopeKind: ProjectMemoryScopeKind
  scopeId: string
  /** Original filename, e.g. "prd-v2.md". */
  name: string
  mimeType: string
  /** Original blob size in bytes. */
  size: number
  /** AI-generated (browser-side), or filename fallback. */
  title: string
  /** AI-generated (browser-side), or first-200-chars fallback. */
  description: string
  status: ProjectMemoryFileStatus
  /** Present only when status === 'failed'. */
  error?: string
  createdAt: string
  updatedAt: string
}

/** Per-scope instruction texts, one per AI surface. Empty string = none. */
export type ProjectInstructions = {
  transcriptionSummary: string
  coCreation: string
  aiCommand: string
}

export const EMPTY_INSTRUCTIONS: ProjectInstructions = {
  transcriptionSummary: '',
  coCreation: '',
  aiCommand: ''
}

// ---------------------------------------------------------------------------
// Retrieval output — what rides on an AI request
// ---------------------------------------------------------------------------

/**
 * The assembled memory payload attached to a co-creation / command request.
 * `block` is the fully formatted, labeled reference block (untrusted-data
 * framing already applied) — prompt assembly just places it.
 */
export type ProjectMemoryContext = {
  block: string
  /** Files included, in the model's selection order (for logging/UI). */
  files: { id: string; title: string; truncated: boolean }[]
}

// ---------------------------------------------------------------------------
// Stage-A catalog / selection JSON shapes
// ---------------------------------------------------------------------------

/** What the selection model sees per file — never the contents. */
export type CatalogEntry = {
  id: string
  title: string
  description: string
}

/** The strict JSON the Stage-A model must return. */
export type StageASelection = {
  files: { id: string; reason?: string }[]
}

// ---------------------------------------------------------------------------
// Caps (locked in PROJECT_MEMORY_LEAD_PLAN.md §1)
// ---------------------------------------------------------------------------

export const PM_MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 20 MB per file
export const PM_TEXT_CHAR_CAP = 250_000 // stored extracted text
export const PM_PER_FILE_TOKEN_CAP = 8_000 // per-file injection
export const PM_TOTAL_TOKEN_BUDGET = 12_000 // per-call injection budget
export const PM_MAX_SELECTED_FILES = 4 // Stage-A pick limit
