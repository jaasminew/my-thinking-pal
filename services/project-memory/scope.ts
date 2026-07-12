// Scope resolution (M1): which memory buckets a canvas reads. The sidebar tree
// is client-owned JSON with no backend counterpart, so resolution is pure tree
// walking. Two-level model (merged semantics): every canvas has its OWN bucket
// (kind 'space'), and a canvas nested inside a project ALSO reads that
// project's shared bucket (kind 'project'). Canvas files travel with the
// canvas when it moves between projects; project files stay with the project.

import type { ProjectMemoryScope } from './types'

/** Structural subset of the app's Sidebar TreeNode — assignable as-is. */
export type ScopeTreeNode = {
  id: string
  kind: 'project' | 'space'
  name: string
  children?: ScopeTreeNode[]
}

/** The two buckets a canvas reads: its own, plus its parent project's if nested. */
export type ResolvedMemoryScopes = {
  /** The parent project's shared bucket — undefined for a top-level canvas. */
  project?: ProjectMemoryScope & { kind: 'project' }
  /** The canvas's own bucket — always present. */
  canvas: ProjectMemoryScope & { kind: 'space' }
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

/** Both buckets for a canvas: its own space scope + the parent project's (when nested). */
export function resolveMemoryScopes(tree: ScopeTreeNode[], spaceId: string): ResolvedMemoryScopes {
  const parent = findParentProject(tree, spaceId)
  return {
    project: parent ? { kind: 'project', projectId: parent.id } : undefined,
    canvas: { kind: 'space', spaceId }
  }
}

/** Display name for a scope (modal header / toggle labels). */
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
