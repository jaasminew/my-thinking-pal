import { useEffect } from 'react'
import type { Backend } from './backend'

// Cross-device document picker. Lists the account's server documents and lets
// the user bind the ACTIVE canvas to one of them — this is how a second device
// joins the same sync room (module 05) instead of spawning a fresh document.
export function DocumentsPanel({
  backend,
  activeSpaceId,
  activeSpaceName,
  onClose
}: {
  backend: Backend
  activeSpaceId: string | null
  activeSpaceName: string
  onClose: () => void
}) {
  const { refreshDocuments } = backend
  useEffect(() => {
    void refreshDocuments()
    // refreshDocuments is a stable useCallback — depend on it, NOT the whole
    // backend object (which is a fresh reference every render → refresh loop).
  }, [refreshDocuments])

  const boundId = activeSpaceId ? backend.docIdFor(activeSpaceId) : undefined

  const openHere = (docId: string) => {
    if (!activeSpaceId) return
    backend.bindDoc(activeSpaceId, docId, true) // adopt the existing doc's content
    onClose()
  }

  const newDoc = async () => {
    const title = window.prompt('New document title', activeSpaceName || 'Untitled')
    if (title === null) return
    const doc = await backend.createDoc(title.trim() || 'Untitled')
    if (doc && activeSpaceId) backend.bindDoc(activeSpaceId, doc.id, true) // start blank
    onClose()
  }

  const rename = async (docId: string, current: string) => {
    const title = window.prompt('Rename document', current)
    if (title === null || !title.trim()) return
    await backend.renameDoc(docId, title.trim())
  }

  const remove = async (docId: string, title: string) => {
    if (!window.confirm(`Delete "${title}"? Its synced content is removed from the server.`)) return
    await backend.deleteDoc(docId)
  }

  return (
    <div className="llm-settings-overlay" onPointerDown={onClose}>
      <div className="llm-settings" onPointerDown={(e) => e.stopPropagation()}>
        <div className="llm-settings-head">
          <strong>Documents</strong>
          <button className="llm-settings-x" onClick={onClose} title="Close">×</button>
        </div>

        <p className="llm-note">
          Bind the active canvas ({activeSpaceName || '—'}) to a document to sync it across your devices.
        </p>

        <div className="doc-list">
          {backend.documents.length === 0 && <p className="llm-note">No documents yet.</p>}
          {backend.documents.map((d) => (
            <div key={d.id} className={`doc-row${d.id === boundId ? ' doc-row-current' : ''}`}>
              <div className="doc-row-main">
                <span className="doc-title">{d.title}</span>
                {d.id === boundId && <span className="doc-badge">current canvas</span>}
                <span className="doc-updated">{new Date(d.updatedAt).toLocaleString()}</span>
              </div>
              <div className="doc-row-actions">
                {d.id !== boundId && (
                  <button className="doc-btn" onClick={() => openHere(d.id)} disabled={!activeSpaceId} title="Bind the active canvas to this document">
                    Open here
                  </button>
                )}
                <button className="doc-btn" onClick={() => rename(d.id, d.title)}>Rename</button>
                <button className="doc-btn doc-btn-danger" onClick={() => remove(d.id, d.title)}>Delete</button>
              </div>
            </div>
          ))}
        </div>

        <div className="llm-settings-actions">
          <button className="llm-save" onClick={newDoc}>New document</button>
        </div>
      </div>
    </div>
  )
}
