// CONTRACTS FROZEN — F1
//
// Project Memory — the single contract file. Every module in this feature
// (Lead-owned retrieval/integration AND Helper-owned storage/extraction/modal/
// client) implements the interfaces below EXACTLY. If something you need is
// missing here, stop and ask the Lead — do not invent an interface.
//
// Wire types (scope, file, instructions, memory context, Stage-A shapes, caps)
// live in `shared-contract/project-memory.ts` and are re-exported here so
// implementers import ONLY from this file.

export type {
  ProjectMemoryScope,
  ProjectMemoryScopeKind,
  ProjectMemoryFile,
  ProjectMemoryFileStatus,
  ProjectInstructions,
  ProjectMemoryContext,
  CatalogEntry,
  StageASelection
} from '../../shared-contract/project-memory'
export {
  scopeKey,
  EMPTY_INSTRUCTIONS,
  mergeInstructions,
  PM_MAX_UPLOAD_BYTES,
  PM_TEXT_CHAR_CAP,
  PM_PER_FILE_TOKEN_CAP,
  PM_TOTAL_TOKEN_BUDGET,
  PM_MAX_SELECTED_FILES,
  PM_MAX_IMAGE_BYTES,
  PM_MAX_RELEASED_IMAGES
} from '../../shared-contract/project-memory'

import type {
  ProjectMemoryScope,
  ProjectMemoryFile,
  ProjectInstructions,
  ProjectMemoryContext
} from '../../shared-contract/project-memory'

// ---------------------------------------------------------------------------
// H1 — LocalStore (IndexedDB, signed-out persistence)
// ---------------------------------------------------------------------------
//
// Dumb storage only: no AI, no retrieval, no title/description generation.
// Records are keyed by file id; scope queries filter on (scopeKind, scopeId).
// Blobs and extracted text go in IndexedDB — NEVER localStorage.

export interface LocalStore {
  /** Insert a new file row (caller has already built the metadata). */
  createFile(meta: ProjectMemoryFile): Promise<void>
  /** All files in a scope, newest first (createdAt desc). */
  listFiles(scope: ProjectMemoryScope): Promise<ProjectMemoryFile[]>
  getFile(id: string): Promise<ProjectMemoryFile | undefined>
  /** Full-row overwrite (status transitions, retry, title/desc updates). */
  updateFile(meta: ProjectMemoryFile): Promise<void>
  /** Delete the row AND its text AND its blob. Missing id = no-op. */
  deleteFile(id: string): Promise<void>

  putText(fileId: string, text: string): Promise<void>
  getText(fileId: string): Promise<string | undefined>

  putBlob(fileId: string, blob: Blob): Promise<void>
  getBlob(fileId: string): Promise<Blob | undefined>

  /** Undefined when the scope has never saved instructions. */
  getInstructions(scope: ProjectMemoryScope): Promise<ProjectInstructions | undefined>
  putInstructions(scope: ProjectMemoryScope, ins: ProjectInstructions): Promise<void>

  /** Orphan cleanup: remove every file (row+text+blob) and the instructions of a scope. */
  deleteScope(scope: ProjectMemoryScope): Promise<void>
}

/** Factory the app calls once. `dbName` override is a test seam (fake-indexeddb). */
export type CreateLocalStore = (dbName?: string) => LocalStore

// ---------------------------------------------------------------------------
// H2 — Browser text extraction (pure, no AI)
// ---------------------------------------------------------------------------

export type ExtractTextResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: 'unsupported' | 'decode-error' }

/**
 * Turn a blob into plain text for the simple formats: .txt, .md, .csv, .json
 * (decide by mimeType first, then filename extension). UTF-8 decode; raw text
 * for CSV/JSON; output capped at PM_TEXT_CHAR_CAP with `truncated` set.
 * Unsupported types return { ok:false, reason:'unsupported' } — NEVER throw.
 * PDF/Office is NOT handled here (server-side, H7).
 */
export type ExtractTextBrowser = (blob: Blob, name: string, mimeType: string) => Promise<ExtractTextResult>

// ---------------------------------------------------------------------------
// H4 — MemoryClient (backend transport, signed-in persistence)
// ---------------------------------------------------------------------------
//
// Thin fetch wrapper over Go /project-memory routes (docs/modules/09-project-memory.md). No AI, no
// retrieval, no retries, no caching. Non-2xx surfaces as MemoryApiError.

export interface MemoryClientDeps {
  /** e.g. apiClient.baseUrl — no trailing slash. */
  baseUrl: string
  /** Returns the current access token, or null when signed out. */
  getToken: () => string | null
  /** Test seam. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
}

export interface UploadFileInput {
  blob: Blob
  name: string
  mimeType: string
  /** Browser-generated (AI or fallback) — the server stores, never generates. */
  title: string
  description: string
  /**
   * Extracted text when the browser could parse the format. Omit for Office —
   * the server extracts those synchronously during upload. For IMAGES this is
   * the browser's vision OCR output and is ALWAYS sent, even when empty (the
   * server has no way to read pixels).
   */
  extractedText?: string
}

export interface MemoryClient {
  listFiles(scope: ProjectMemoryScope): Promise<ProjectMemoryFile[]>
  /** multipart/form-data; server responds with the stored row (status reflects extraction outcome). */
  uploadFile(scope: ProjectMemoryScope, input: UploadFileInput): Promise<ProjectMemoryFile>
  deleteFile(fileId: string): Promise<void>
  getText(fileId: string): Promise<string>
  /** Original uploaded bytes — used to re-attach image files at AI-call time. */
  getBlob(fileId: string): Promise<Blob>
  getInstructions(scope: ProjectMemoryScope): Promise<ProjectInstructions>
  putInstructions(scope: ProjectMemoryScope, ins: ProjectInstructions): Promise<void>
  /** Whole-scope orphan cleanup (project/space deleted client-side). */
  deleteScope(scope: ProjectMemoryScope): Promise<void>
}

/** Factory: `createMemoryClient(deps)` exported from services/project-memory/client.ts. */
export type CreateMemoryClient = (deps: MemoryClientDeps) => MemoryClient

/**
 * Typed error for non-2xx responses (mirror services/api/client.ts ApiError).
 * Defined here (not client.ts) so a plain `import { MemoryApiError } from
 * './types'` gets a real runtime value, not just a type; client.ts re-exports
 * it for callers that import from there instead.
 */
export class MemoryApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'MemoryApiError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// H3 — ProjectMemoryModal (presentational only)
// ---------------------------------------------------------------------------
//
// Pure props-driven component; no fetching, no stores, no App import. The
// mounter supplies one section per visible scope; each section carries its own
// callbacks so the modal never needs to know which storage bucket is behind it.

/** One memory bucket as the modal sees it (project or canvas scope). */
export interface MemoryScopeSection {
  /** Human name of the scope's tree node (toggle label / header). */
  name: string
  files: ProjectMemoryFile[]
  instructions: ProjectInstructions
  /** True when the shown instructions match the last persisted state. */
  instructionsSaved: boolean
  onUpload: (files: File[]) => void
  onDeleteFile: (id: string) => void
  onRetryFile: (id: string) => void
  onSaveInstructions: (ins: ProjectInstructions) => void
}

export interface ProjectMemoryModalProps {
  /** Shared project bucket — null when the canvas is top-level (no project tab). */
  project: MemoryScopeSection | null
  /** The canvas's own bucket — null when opened from a project row (no canvas tab). */
  canvas: MemoryScopeSection | null
  /** Which tab opens first; defaults to 'canvas' when present, else 'project'. */
  initialScope?: 'project' | 'canvas'
  /** True while an upload/delete/save round-trip is in flight. */
  busy: boolean
  /** Non-null renders an inline error banner. */
  error: string | null
  onClose: () => void
}

// ---------------------------------------------------------------------------
// M1 — useProjectMemory hook return shape (Lead-owned)
// ---------------------------------------------------------------------------

/** One live memory bucket (scope + data + mutations), as the hook exposes it. */
export interface MemoryBucket {
  scope: ProjectMemoryScope
  /** Display name of the scope's tree node. */
  name: string
  files: ProjectMemoryFile[]
  instructions: ProjectInstructions
  instructionsSaved: boolean
  uploadFiles: (files: File[]) => Promise<void>
  deleteFile: (id: string) => Promise<void>
  retryFile: (id: string) => Promise<void>
  saveInstructions: (ins: ProjectInstructions) => Promise<void>
}

export interface UseProjectMemoryResult {
  /** Parent project's shared bucket — null for a top-level canvas. */
  project: MemoryBucket | null
  /** The canvas's own bucket — null only while the deps are inert. */
  canvas: MemoryBucket | null
  /**
   * Merged instructions for AI calls: project first, canvas appended.
   * AI call sites read THIS, never the per-bucket instructions.
   */
  instructions: ProjectInstructions
  loading: boolean
  busy: boolean
  error: string | null
  /**
   * Catalog (project + canvas files merged) → Stage-A pick → whole-file
   * release, formatted as a labeled block. Null when the catalog is empty or
   * nothing was selected. Never throws.
   */
  buildMemoryContext: (
    task: string,
    options?: {
      /** Role-configured selection call; defaults to the active API provider. */
      call?: (system: string, user: string) => Promise<string>
      /** Let the selection pass propose a web query even when the catalog is empty. */
      allowWebSearch?: boolean
    }
  ) => Promise<ProjectMemoryContext | null>
}
