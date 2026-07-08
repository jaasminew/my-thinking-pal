import { useState, type ReactNode } from 'react'

// One node in the sidebar nav tree: a project (folder that holds idea spaces)
// or an idea space (an infinite canvas). Persisted as plain JSON.
export type TreeNode = {
  id: string
  kind: 'project' | 'space'
  name: string
  children?: TreeNode[]
}

// ---- stroke icons (match the light hand-drawn chrome of the mock) ----
const icon = (paths: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {paths}
  </svg>
)
const PanelToggleIcon = icon(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9.5 4v16" /></>)
const FolderPlusIcon = icon(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /><path d="M12 11.5v4M10 13.5h4" /></>)
const PencilIcon = icon(<><path d="M4 20l1-4L16.5 4.5a2.12 2.12 0 0 1 3 3L8 19l-4 1z" /><path d="M14.5 6.5l3 3" /></>)
const FolderIcon = icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />)
// Notebook icon used on the panel spines (exported for App).
export const BookIcon = icon(<><path d="M5 5a2 2 0 0 1 2-2h12v16H7a2 2 0 0 0-2 2V5z" /><path d="M5 19a2 2 0 0 1 2-2h12" /></>)

export function Sidebar({
  collapsed,
  onToggle,
  tree,
  activeId,
  selectedId,
  renamingId,
  onSelect,
  onNewProject,
  onNewIdeaSpace,
  onStartRename,
  onRename,
  onMoveNode,
  onContextMenu,
  footer
}: {
  collapsed: boolean
  onToggle: () => void
  tree: TreeNode[]
  activeId: string
  selectedId: string | null
  renamingId: string | null
  onSelect: (node: TreeNode) => void
  onNewProject: () => void
  onNewIdeaSpace: () => void
  onStartRename: (id: string) => void
  onRename: (id: string, name: string) => void
  onMoveNode: (id: string, targetProjectId: string | null) => void
  onContextMenu: (node: TreeNode, x: number, y: number) => void
  footer?: ReactNode
}) {
  // Highlights the project row (or the root drop zone) currently under a
  // dragged canvas, and drives the cursor-following "Move into ..." tooltip.
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragOverRoot, setDragOverRoot] = useState(false)
  const [dragLabel, setDragLabel] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null)

  const clearDrag = () => {
    setDragOverId(null)
    setDragOverRoot(false)
    setDragLabel(null)
    setTooltip(null)
  }

  const renderNode = (n: TreeNode, depth: number): ReactNode => (
    <div key={n.id}>
      <div
        className={`tree-row${selectedId === n.id ? ' sel' : ''}${activeId === n.id ? ' active' : ''}${dragOverId === n.id ? ' drag-over' : ''}`}
        draggable={n.kind === 'space'}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', n.id)
          setDragLabel(n.name)
        }}
        onDragOver={(e) => {
          if (n.kind !== 'project') return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          setDragOverId(n.id)
          setDragOverRoot(false)
          setTooltip({ x: e.clientX, y: e.clientY, text: `Move into "${n.name}"` })
        }}
        onDragEnter={(e) => {
          if (n.kind !== 'project') return
          e.preventDefault()
          e.stopPropagation()
        }}
        onDragLeave={(e) => {
          if (n.kind !== 'project') return
          e.stopPropagation()
          setDragOverId((id) => (id === n.id ? null : id))
        }}
        onDrop={(e) => {
          if (n.kind !== 'project') return
          e.preventDefault()
          e.stopPropagation()
          const draggedId = e.dataTransfer.getData('text/plain')
          if (draggedId) onMoveNode(draggedId, n.id)
          clearDrag()
        }}
        onDragEnd={clearDrag}
        onClick={() => onSelect(n)}
        onDoubleClick={() => onStartRename(n.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onContextMenu(n, e.clientX, e.clientY)
        }}
        title="Double-click to rename"
      >
        {n.kind === 'project' ? FolderIcon : PencilIcon}
        {renamingId === n.id ? (
          <input
            className="tree-rename"
            defaultValue={n.name}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => onRename(n.id, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.currentTarget.value = n.name
                e.currentTarget.blur()
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="tree-name">{n.name}</span>
        )}
      </div>
      {n.children && n.children.length > 0 && (
        <div className="tree-kids">{n.children.map((c) => renderNode(c, depth + 1))}</div>
      )}
    </div>
  )

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="side-toggle-row">
        <button className="side-toggle" onClick={onToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {PanelToggleIcon}
        </button>
      </div>
      <button className="side-btn" onClick={onNewProject} title="New Project">
        {FolderPlusIcon}
        {!collapsed && <span>New Project</span>}
      </button>
      <button className="side-btn" onClick={onNewIdeaSpace} title="New Idea Space">
        {PencilIcon}
        {!collapsed && <span>New Idea Space</span>}
      </button>
      {!collapsed && (
        <div
          className={`side-tree${dragOverRoot ? ' drag-over-root' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDragOverId(null)
            setDragOverRoot(true)
            setTooltip({ x: e.clientX, y: e.clientY, text: 'Move to top level' })
          }}
          onDragLeave={() => setDragOverRoot(false)}
          onDrop={(e) => {
            e.preventDefault()
            const draggedId = e.dataTransfer.getData('text/plain')
            if (draggedId) onMoveNode(draggedId, null)
            clearDrag()
          }}
        >
          {tree.map((n) => renderNode(n, 0))}
        </div>
      )}
      {!collapsed && footer && <div className="side-footer">{footer}</div>}
      {tooltip && dragLabel && (
        <div className="drag-tooltip" style={{ left: tooltip.x + 16, top: tooltip.y - 10, transform: 'translateY(-100%)' }}>
          <div className="drag-tooltip-title">
            {PencilIcon}
            <span>{dragLabel}</span>
          </div>
          <div className="drag-tooltip-sub">{tooltip.text}</div>
        </div>
      )}
    </aside>
  )
}
