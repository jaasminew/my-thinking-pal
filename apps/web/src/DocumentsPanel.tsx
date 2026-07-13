import { useEffect } from 'react'
import type { Backend } from './backend'
import { useLocale } from './locale'

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
  const { tr } = useLocale()
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
    const title = window.prompt(tr('New document title', '新文档标题'), activeSpaceName || tr('Untitled', '未命名'))
    if (title === null) return
    const doc = await backend.createDoc(title.trim() || tr('Untitled', '未命名'))
    if (doc && activeSpaceId) backend.bindDoc(activeSpaceId, doc.id, true) // start blank
    onClose()
  }

  const rename = async (docId: string, current: string) => {
    const title = window.prompt(tr('Rename document', '重命名文档'), current)
    if (title === null || !title.trim()) return
    await backend.renameDoc(docId, title.trim())
  }

  const remove = async (docId: string, title: string) => {
    if (!window.confirm(tr(`Delete "${title}"? Its synced content is removed from the server.`, `删除“${title}”？其已同步的内容将从服务器移除。`))) return
    await backend.deleteDoc(docId)
  }

  return (
    <div className="llm-settings-overlay" onPointerDown={onClose}>
      <div className="llm-settings" onPointerDown={(e) => e.stopPropagation()}>
        <div className="llm-settings-head">
          <strong>{tr('Documents', '文档')}</strong>
          <button className="llm-settings-x" onClick={onClose} title={tr('Close', '关闭')}>×</button>
        </div>

        <p className="llm-note">
          {tr(`Bind the active canvas (${activeSpaceName || '—'}) to a document to sync it across your devices.`, `将当前画布（${activeSpaceName || '—'}）关联到文档，以在设备间同步。`)}
        </p>

        <div className="doc-list">
          {backend.documents.length === 0 && <p className="llm-note">{tr('No documents yet.', '还没有文档。')}</p>}
          {backend.documents.map((d) => (
            <div key={d.id} className={`doc-row${d.id === boundId ? ' doc-row-current' : ''}`}>
              <div className="doc-row-main">
                <span className="doc-title">{d.title}</span>
                {d.id === boundId && <span className="doc-badge">{tr('current canvas', '当前画布')}</span>}
                <span className="doc-updated">{new Date(d.updatedAt).toLocaleString()}</span>
              </div>
              <div className="doc-row-actions">
                {d.id !== boundId && (
                  <button className="doc-btn" onClick={() => openHere(d.id)} disabled={!activeSpaceId} title={tr('Bind the active canvas to this document', '将当前画布关联到此文档')}>
                    {tr('Open here', '在此打开')}
                  </button>
                )}
                <button className="doc-btn" onClick={() => rename(d.id, d.title)}>{tr('Rename', '重命名')}</button>
                <button className="doc-btn doc-btn-danger" onClick={() => remove(d.id, d.title)}>{tr('Delete', '删除')}</button>
              </div>
            </div>
          ))}
        </div>

        <div className="llm-settings-actions">
          <button className="llm-save" onClick={newDoc}>{tr('New document', '新建文档')}</button>
        </div>
      </div>
    </div>
  )
}
