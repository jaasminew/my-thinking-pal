import { describe, expect, it } from 'vitest'
import { findParentProject, resolveMemoryScopes, scopeDisplayName, type ScopeTreeNode } from './scope'

const tree: ScopeTreeNode[] = [
  { id: 'top-space', kind: 'space', name: 'Loose Canvas' },
  {
    id: 'proj-a',
    kind: 'project',
    name: 'Project A',
    children: [
      { id: 'a-1', kind: 'space', name: 'A One' },
      { id: 'a-2', kind: 'space', name: 'A Two' }
    ]
  },
  { id: 'proj-empty', kind: 'project', name: 'Empty', children: [] }
]

describe('findParentProject', () => {
  it('finds the project containing a space', () => {
    expect(findParentProject(tree, 'a-2')?.id).toBe('proj-a')
  })

  it('returns undefined for a top-level space', () => {
    expect(findParentProject(tree, 'top-space')).toBeUndefined()
  })

  it('returns undefined for an unknown id', () => {
    expect(findParentProject(tree, 'nope')).toBeUndefined()
  })
})

describe('resolveMemoryScopes', () => {
  it('nested canvas reads its own bucket AND the parent project bucket', () => {
    expect(resolveMemoryScopes(tree, 'a-1')).toEqual({
      project: { kind: 'project', projectId: 'proj-a' },
      canvas: { kind: 'space', spaceId: 'a-1' }
    })
  })

  it('top-level canvas has only its own bucket', () => {
    expect(resolveMemoryScopes(tree, 'top-space')).toEqual({
      project: undefined,
      canvas: { kind: 'space', spaceId: 'top-space' }
    })
  })

  it('a canvas keeps its own bucket when moved out of a project', () => {
    const moved: ScopeTreeNode[] = [
      { id: 'top-space', kind: 'space', name: 'Loose Canvas' },
      { id: 'proj-a', kind: 'project', name: 'Project A', children: [{ id: 'a-2', kind: 'space', name: 'A Two' }] },
      { id: 'a-1', kind: 'space', name: 'A One' } // moved out to root
    ]
    expect(resolveMemoryScopes(moved, 'a-1')).toEqual({
      project: undefined,
      canvas: { kind: 'space', spaceId: 'a-1' }
    })
  })
})

describe('scopeDisplayName', () => {
  it('names a project scope', () => {
    expect(scopeDisplayName(tree, { kind: 'project', projectId: 'proj-a' })).toBe('Project A')
  })

  it('names a space scope', () => {
    expect(scopeDisplayName(tree, { kind: 'space', spaceId: 'top-space' })).toBe('Loose Canvas')
  })

  it('falls back to a generic label when the node is gone', () => {
    expect(scopeDisplayName(tree, { kind: 'space', spaceId: 'deleted' })).toBe('Canvas')
  })
})
