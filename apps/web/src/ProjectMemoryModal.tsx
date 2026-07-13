// H3 — Project Memory modal (presentational only).
//
// A pure, props-driven component for two-level memory: it renders one or two
// scope sections (the project's shared bucket, the canvas's own bucket) behind
// a scope toggle, showing the active scope's knowledge-base file list and
// instructions, and fires that section's callbacks for every action. It does
// NOT fetch, store, call backends, or know about App/Sidebar. The mounter
// supplies every prop/callback. Export the component only.

import { useEffect, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react'
import type {
  MemoryScopeSection,
  ProjectInstructions,
  ProjectMemoryFileStatus,
  ProjectMemoryModalProps
} from '../../../services/project-memory/types'
import './ProjectMemoryModal.css'
import { useLocale } from './locale'

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
const FolderIcon = icon(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
)
const CanvasIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
  </>
)

type InstructionField = 'transcriptionSummary' | 'coCreation' | 'aiCommand'
type ScopeTab = 'project' | 'canvas'

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

/** One scope's body: dropzone + file list + instructions, all wired to that
 * section's callbacks. Draft state lives here so each scope keeps its own
 * unsaved edits while the user flips between scope tabs. */
function ScopeBody({ section, busy }: { section: MemoryScopeSection; busy: boolean }) {
  const { tr, chinese } = useLocale()
  const [tab, setTab] = useState<InstructionField>('transcriptionSummary')
  const [draft, setDraft] = useState<ProjectInstructions>(section.instructions)
  const [dragOver, setDragOver] = useState(false)

  // Resync the local draft when the persisted instructions prop changes
  // (initial load, after a save round-trip, or a scope switch).
  useEffect(() => {
    setDraft(section.instructions)
  }, [section.instructions])

  const dirty = !fieldsEqual(draft, section.instructions)
  const draftEmpty =
    !draft.transcriptionSummary.trim() &&
    !draft.coCreation.trim() &&
    !draft.aiCommand.trim()
  const tabs = TABS.map((t) => ({ ...t, label: t.field === 'transcriptionSummary' ? tr('Transcription summary', '转写摘要') : t.field === 'coCreation' ? tr('AI co-creation', 'AI 共创') : tr('AI command', 'AI 指令') }))
  const activeLabel = tabs.find((t) => t.field === tab)!.label
  const savedLabel = busy ? tr('Saving…', '保存中…') : dirty ? tr('Unsaved changes', '未保存的更改') : section.instructionsSaved ? tr('Saved', '已保存') : tr('Draft', '草稿')

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files ?? [])
    if (dropped.length) section.onUpload(dropped)
  }

  const handlePick = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    if (picked.length) section.onUpload(picked)
    e.target.value = '' // allow re-picking the same file
  }

  return (
    <>
      <section className="pm-section">
        <h3>{tr('Knowledge base', '知识库')}</h3>
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
            aria-label={tr('Upload files', '上传文件')}
          />
          {UploadIcon}
          <span>{tr('Drop files here or click to upload', '将文件拖到这里，或点击上传')}</span>
        </label>

        <ul className="pm-file-list">
          {section.files.map((f) => (
            <li key={f.id} className="pm-file-row" data-testid={`file-${f.id}`}>
              <span className="pm-file-icon">{DocIcon}</span>
              <span className="pm-file-meta">
                <span className="pm-file-title">{f.title}</span>
                <span className="pm-file-desc">{f.description}</span>
              </span>
              <span className={`pm-status pm-status-${f.status}`}>{chinese ? ({ queued: '排队中', extracting: '提取中…', indexed: '已索引', failed: '失败' } as const)[f.status] : STATUS_LABEL[f.status]}</span>
              <span className="pm-file-size">{formatSize(f.size)}</span>
              <span className="pm-file-actions">
                {f.status === 'failed' && (
                  <button
                    className="pm-icon-btn"
                    onClick={() => section.onRetryFile(f.id)}
                    aria-label={tr(`Retry ${f.title}`, `重试 ${f.title}`)}
                    disabled={busy}
                  >
                    {RetryIcon}
                  </button>
                )}
                <button
                  className="pm-icon-btn"
                  onClick={() => section.onDeleteFile(f.id)}
                  aria-label={tr(`Delete ${f.title}`, `删除 ${f.title}`)}
                  disabled={busy}
                >
                  {TrashIcon}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="pm-separator" role="separator" aria-hidden="true" />

      <section className="pm-section">
        <h3>{tr('Instructions', '指令')}</h3>
        <div className="pm-tabs" role="tablist">
          {tabs.map((t) => (
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
          placeholder={tr(`Instructions for ${activeLabel.toLowerCase()}…`, `${activeLabel}指令…`)}
        />
        <div className="pm-instr-foot">
          <span className="pm-saved-indicator" data-testid="saved-indicator">
            {savedLabel}
          </span>
          <button
            className="pm-save-btn"
            onClick={() => section.onSaveInstructions(draft)}
            disabled={busy || draftEmpty}
          >
            {tr('Save instructions', '保存指令')}
          </button>
        </div>
      </section>
    </>
  )
}

export function ProjectMemoryModal({
  project,
  canvas,
  initialScope,
  busy,
  error,
  onClose
}: ProjectMemoryModalProps) {
  const { tr } = useLocale()
  const [scope, setScope] = useState<ScopeTab>(() => {
    if (initialScope === 'project' && project) return 'project'
    if (initialScope === 'canvas' && canvas) return 'canvas'
    return canvas ? 'canvas' : 'project'
  })
  const active = scope === 'project' ? project : canvas
  const showToggle = !!project && !!canvas

  if (!active) return null // nothing to show (mounter should not do this)

  return (
    <div
      className="pm-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={tr(`Project memory — ${active.name}`, `项目记忆 — ${active.name}`)}
    >
      <div className="pm-modal">
        <header className="pm-modal-head">
          <h2>{tr(`Memory — ${active.name}`, `记忆 — ${active.name}`)}</h2>
          <button className="pm-icon-btn" onClick={onClose} aria-label={tr('Close', '关闭')} disabled={busy}>
            {CloseIcon}
          </button>
        </header>

        {showToggle && (
          <div className="pm-scope-toggle" role="tablist" aria-label={tr('Memory scope', '记忆范围')}>
            <button
              role="tab"
              aria-selected={scope === 'project'}
              className={`pm-scope-tab${scope === 'project' ? ' active' : ''}`}
              onClick={() => setScope('project')}
            >
              {FolderIcon}
              <span>{tr(`Project — ${project!.name}`, `项目 — ${project!.name}`)}</span>
              <span className="pm-scope-tooltip" aria-hidden="true" data-testid="project-scope-tooltip">
                {tr('Knowledge base content is shared with all canvases in this project.', '知识库内容会共享给此项目中的所有画布。')}
              </span>
            </button>
            <button
              role="tab"
              aria-selected={scope === 'canvas'}
              className={`pm-scope-tab${scope === 'canvas' ? ' active' : ''}`}
              onClick={() => setScope('canvas')}
            >
              {CanvasIcon}
              <span>{tr(`This canvas — ${canvas!.name}`, `此画布 — ${canvas!.name}`)}</span>
              <span className="pm-scope-tooltip" aria-hidden="true" data-testid="canvas-scope-tooltip">
                {tr('Knowledge base content is visible only to this canvas.', '知识库内容仅对此画布可见。')}
              </span>
            </button>
          </div>
        )}

        {error && <div className="pm-error" role="alert">{error}</div>}

        {/* Both bodies stay mounted so each bucket keeps its own unsaved
            draft/tab state alive across scope toggles. */}
        {project && (
          <div hidden={scope !== 'project'}>
            <ScopeBody section={project} busy={busy} />
          </div>
        )}
        {canvas && (
          <div hidden={scope !== 'canvas'}>
            <ScopeBody section={canvas} busy={busy} />
          </div>
        )}
      </div>
    </div>
  )
}
