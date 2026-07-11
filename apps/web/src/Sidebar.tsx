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
const FolderIcon = icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />)
export const CanvasIcon = (
  <svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden>
    <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-520h560v-120H200v120Zm560 80H200v360h560v-360Zm-560-80v80-80Zm0 0v-120 120Zm0 80v360-360Z" />
  </svg>
)
const CanvasPlusIcon = (
  <svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden>
    <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-520h560v-120H200v120Zm560 80H200v360h560v-360Zm-560-80v80-80Zm0 0v-120 120Zm0 80v360-360Z" />
    <path d="M440-512h80v52h52v80h-52v52h-80v-52h-52v-80h52v-52Z" />
  </svg>
)
// Notebook icon used on the panel spines (exported for App).
export const BookIcon = icon(<><path d="M5 5a2 2 0 0 1 2-2h12v16H7a2 2 0 0 0-2 2V5z" /><path d="M5 19a2 2 0 0 1 2-2h12" /></>)
// Archive-box icon for Project Memory entry points.
export const MemoryIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
    <path d="M10 13h4" />
  </>
)

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
  onOpenProjectMemory,
  onOpenCanvasMemory,
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
  /** Opens the Memory modal for a project (hover toolbox on project rows). */
  onOpenProjectMemory?: (projectId: string) => void
  /** Opens the Memory modal for a canvas (hover memory button on canvas rows). */
  onOpenCanvasMemory?: (spaceId: string) => void
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
        {n.kind === 'project' ? FolderIcon : CanvasIcon}
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
        {((n.kind === 'project' && onOpenProjectMemory) || (n.kind === 'space' && onOpenCanvasMemory)) && renamingId !== n.id && (
          <button
            className="row-tool"
            title={`Memory — ${n.name}`}
            aria-label={`Open memory for ${n.name}`}
            onClick={(e) => {
              e.stopPropagation()
              if (n.kind === 'project') onOpenProjectMemory?.(n.id)
              else {
                // Canvas memory is hosted by the canvas panel itself. Make
                // sure its panel is mounted before asking App to open it.
                onSelect(n)
                onOpenCanvasMemory?.(n.id)
              }
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {MemoryIcon}
          </button>
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
        {CanvasPlusIcon}
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
      {footer && <div className="side-footer">{footer}</div>}
      {tooltip && dragLabel && (
        <div className="drag-tooltip" style={{ left: tooltip.x + 16, top: tooltip.y - 10, transform: 'translateY(-100%)' }}>
          <div className="drag-tooltip-title">
            {CanvasIcon}
            <span>{dragLabel}</span>
          </div>
          <div className="drag-tooltip-sub">{tooltip.text}</div>
        </div>
      )}
    </aside>
  )
}
