/**
 * SHARED CONTRACT — Project Memory wire types.
 *
 * These are the transport-neutral shapes shared by the web UI, the retrieval
 * layer, and the Go backend's JSON. Browser-only interfaces (IndexedDB store,
 * fetch client, React props/hook) live in `services/project-memory/types.ts`,
 * which re-exports everything here.
 *
 * Design (see docs/modules/09-project-memory.md): the server is a dumb store —
 * it never calls AI and never holds an API key. Title/description generation
 * and file selection run in the browser with the user's own provider settings.
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

/**
 * Merge two instruction sets for AI calls (two-level memory): project
 * instructions first, canvas instructions appended — so the canvas can
 * specialize or override the project's standing guidance ("specific beats
 * general" reads last). Empty fields drop out cleanly.
 */
export function mergeInstructions(
  project: ProjectInstructions | undefined,
  canvas: ProjectInstructions | undefined
): ProjectInstructions {
  const join = (a?: string, b?: string) =>
    [a?.trim(), b?.trim()].filter(Boolean).join('\n\n')
  return {
    transcriptionSummary: join(project?.transcriptionSummary, canvas?.transcriptionSummary),
    coCreation: join(project?.coCreation, canvas?.coCreation),
    aiCommand: join(project?.aiCommand, canvas?.aiCommand)
  }
}

// ---------------------------------------------------------------------------
// Retrieval output — what rides on an AI request
// ---------------------------------------------------------------------------

/**
 * The assembled memory payload attached to a co-creation / command request.
 * `block` is the fully formatted, labeled reference block (untrusted-data
 * framing already applied) — prompt assembly just places it. Selected IMAGE
 * files ride separately as data URLs: at upload time only their OCR text is
 * stored (so the catalog/Stage-A can reason about them), but at call time the
 * model gets the actual pixels.
 */
export type ProjectMemoryContext = {
  block: string
  /** Files included, in the model's selection order (for logging/UI). */
  files: { id: string; title: string; truncated: boolean }[]
  /** Selected image files, attached to the request as multimodal parts. */
  images?: { id: string; title: string; dataUrl: string }[]
  /** Optional focused query proposed during the catalog-selection pass. */
  webSearchQuery?: string
}

// ---------------------------------------------------------------------------
// Stage-A catalog / selection JSON shapes
// ---------------------------------------------------------------------------

/** What the selection model sees per file — never the contents. */
export type CatalogEntry = {
  id: string
  title: string
  description: string
  /** True for image files — released as pixels, not text, when picked. */
  image?: boolean
}

/** The strict JSON the Stage-A model must return. */
export type StageASelection = {
  files: { id: string; reason?: string }[]
  /** Empty/omitted when uploaded knowledge is sufficient for the task. */
  webSearchQuery?: string
}

// ---------------------------------------------------------------------------
// Caps (see docs/modules/09-project-memory.md)
// ---------------------------------------------------------------------------

export const PM_MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 20 MB per file
export const PM_TEXT_CHAR_CAP = 250_000 // stored extracted text
export const PM_PER_FILE_TOKEN_CAP = 8_000 // per-file injection
export const PM_TOTAL_TOKEN_BUDGET = 12_000 // per-call injection budget
export const PM_MAX_SELECTED_FILES = 4 // Stage-A pick limit
export const PM_MAX_IMAGE_BYTES = 4 * 1024 * 1024 // per-image release cap (provider payload limits)
export const PM_MAX_RELEASED_IMAGES = 2 // images attached per AI call
