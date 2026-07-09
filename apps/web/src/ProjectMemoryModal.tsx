// H3 — Project Memory modal (presentational only).
//
// A pure, props-driven component: it renders the knowledge-base file list and
// the per-scope project instructions, and fires callbacks for every action. It
// does NOT fetch, store, call backends, or know about App/Sidebar. The Lead
// mounts it and supplies every prop/callback. Export the component only.

import { useEffect, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react'
import type {
  ProjectInstructions,
  ProjectMemoryFile,
  ProjectMemoryFileStatus,
  ProjectMemoryModalProps
} from '../../../services/project-memory/types'
import './ProjectMemoryModal.css'

// ---- stroke icons (mirror the light hand-drawn chrome of Sidebar.tsx) ----
const icon = (paths: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {paths}
  </svg>
)
const DocIcon = icon(
  <>
    <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M14 3v5h5" />
  </>
)
const TrashIcon = icon(
  <>
    <path d="M4 7h16" />
    <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
  </>
)
const RetryIcon = icon(
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v4h4" />
  </>
)
const CloseIcon = icon(
  <>
    <path d="M6 6l12 12" />
    <path d="M18 6L6 18" />
  </>
)
const UploadIcon = icon(
  <>
    <path d="M12 16V4" />
    <path d="M7 9l5-5 5 5" />
    <path d="M5 20h14" />
  </>
)

type InstructionField = 'transcriptionSummary' | 'coCreation' | 'aiCommand'

const TABS: { field: InstructionField; label: string }[] = [
  { field: 'transcriptionSummary', label: 'Transcription summary' },
  { field: 'coCreation', label: 'AI co-creation' },
  { field: 'aiCommand', label: 'AI command' }
]

const STATUS_LABEL: Record<ProjectMemoryFileStatus, string> = {
  queued: 'Queued',
  extracting: 'Extracting…',
  indexed: 'Indexed',
  failed: 'Failed'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fieldsEqual(a: ProjectInstructions, b: ProjectInstructions): boolean {
  return (
    a.transcriptionSummary === b.transcriptionSummary &&
    a.coCreation === b.coCreation &&
    a.aiCommand === b.aiCommand
  )
}

export function ProjectMemoryModal({
  scopeName,
  files,
  instructions,
  busy,
  instructionsSaved,
  error,
  onUpload,
  onDeleteFile,
  onRetryFile,
  onSaveInstructions,
  onClose
}: ProjectMemoryModalProps) {
  const [tab, setTab] = useState<InstructionField>('transcriptionSummary')
  const [draft, setDraft] = useState<ProjectInstructions>(instructions)
  const [dragOver, setDragOver] = useState(false)

  // Resync the local draft when the persisted instructions prop changes
  // (initial load, after a save round-trip, or a scope switch).
  useEffect(() => {
    setDraft(instructions)
  }, [instructions])

  const dirty = !fieldsEqual(draft, instructions)
  const savedLabel = busy ? 'Saving…' : dirty ? 'Unsaved changes' : instructionsSaved ? 'Saved' : 'Draft'
  const activeLabel = TABS.find((t) => t.field === tab)!.label

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files ?? [])
    if (dropped.length) onUpload(dropped)
  }

  const handlePick = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    if (picked.length) onUpload(picked)
    e.target.value = '' // allow re-picking the same file
  }

  return (
    <div
      className="pm-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Project memory — ${scopeName}`}
    >
      <div className="pm-modal">
        <header className="pm-modal-head">
          <h2>Project Memory — {scopeName}</h2>
          <button className="pm-icon-btn" onClick={onClose} aria-label="Close" disabled={busy}>
            {CloseIcon}
          </button>
        </header>

        {error && <div className="pm-error" role="alert">{error}</div>}

        <section className="pm-section">
          <h3>Knowledge base</h3>
          <label
            className={`pm-dropzone${dragOver ? ' drag-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <input
              type="file"
              multiple
              className="pm-file-input"
              onChange={handlePick}
              aria-label="Upload files"
            />
            {UploadIcon}
            <span>Drop files here or click to upload</span>
          </label>

          <ul className="pm-file-list">
            {files.map((f) => (
              <li key={f.id} className="pm-file-row" data-testid={`file-${f.id}`}>
                <span className="pm-file-icon">{DocIcon}</span>
                <span className="pm-file-meta">
                  <span className="pm-file-title">{f.title}</span>
                  <span className="pm-file-desc">{f.description}</span>
                </span>
                <span className={`pm-status pm-status-${f.status}`}>{STATUS_LABEL[f.status]}</span>
                <span className="pm-file-size">{formatSize(f.size)}</span>
                <span className="pm-file-actions">
                  {f.status === 'failed' && (
                    <button
                      className="pm-icon-btn"
                      onClick={() => onRetryFile(f.id)}
                      aria-label={`Retry ${f.title}`}
                      disabled={busy}
                    >
                      {RetryIcon}
                    </button>
                  )}
                  <button
                    className="pm-icon-btn"
                    onClick={() => onDeleteFile(f.id)}
                    aria-label={`Delete ${f.title}`}
                    disabled={busy}
                  >
                    {TrashIcon}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="pm-section">
          <h3>Project instructions</h3>
          <div className="pm-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.field}
                role="tab"
                aria-selected={tab === t.field}
                className={`pm-tab${tab === t.field ? ' active' : ''}`}
                onClick={() => setTab(t.field)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <textarea
            className="pm-textarea"
            aria-label={activeLabel}
            value={draft[tab]}
            onChange={(e) => setDraft({ ...draft, [tab]: e.target.value })}
            placeholder={`Instructions for ${activeLabel.toLowerCase()}…`}
          />
          <div className="pm-instr-foot">
            <span className="pm-saved-indicator" data-testid="saved-indicator">
              {savedLabel}
            </span>
            <button
              className="pm-save-btn"
              onClick={() => onSaveInstructions(draft)}
              disabled={busy}
            >
              Save instructions
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
