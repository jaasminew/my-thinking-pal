// Scope resolution (M1): which memory bucket a canvas reads. The sidebar tree
// is client-owned JSON with no backend counterpart, so resolution is pure tree
// walking — a canvas inside a project uses the project's bucket; a top-level
// canvas uses its own. A canvas MOVED into/out of a project therefore changes
// buckets by design (the modal shows the active scope name to make it visible).

import type { ProjectMemoryScope } from './types'

/** Structural subset of the app's Sidebar TreeNode — assignable as-is. */
export type ScopeTreeNode = {
  id: string
  kind: 'project' | 'space'
  name: string
  children?: ScopeTreeNode[]
}

/** The project node that directly contains `spaceId`, or undefined at root. */
export function findParentProject(tree: ScopeTreeNode[], spaceId: string): ScopeTreeNode | undefined {
  for (const node of tree) {
    if (node.kind === 'project' && node.children?.some((c) => c.id === spaceId)) return node
    if (node.children) {
      const hit = findParentProject(node.children, spaceId)
      if (hit) return hit
    }
  }
  return undefined
}

/** Resolved memory scope for a canvas: parent project's if nested, else its own. */
export function memoryScopeForSpace(tree: ScopeTreeNode[], spaceId: string): ProjectMemoryScope {
  const parent = findParentProject(tree, spaceId)
  return parent ? { kind: 'project', projectId: parent.id } : { kind: 'space', spaceId }
}

/** Display name for the resolved scope (modal header). */
export function scopeDisplayName(tree: ScopeTreeNode[], scope: ProjectMemoryScope): string {
  const id = scope.kind === 'project' ? scope.projectId : scope.spaceId
  const node = findNode(tree, id)
  return node?.name ?? (scope.kind === 'project' ? 'Project' : 'Canvas')
}

function findNode(nodes: ScopeTreeNode[], id: string): ScopeTreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children) {
      const hit = findNode(n.children, id)
      if (hit) return hit
    }
  }
  return undefined
}
