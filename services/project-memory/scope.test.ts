import { describe, expect, it } from 'vitest'
import { findParentProject, memoryScopeForSpace, scopeDisplayName, type ScopeTreeNode } from './scope'

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

describe('memoryScopeForSpace', () => {
  it('resolves to the parent project scope when nested', () => {
    expect(memoryScopeForSpace(tree, 'a-1')).toEqual({ kind: 'project', projectId: 'proj-a' })
  })

  it('resolves to the space itself at top level', () => {
    expect(memoryScopeForSpace(tree, 'top-space')).toEqual({ kind: 'space', spaceId: 'top-space' })
  })

  it('moving a space between buckets changes its resolved scope', () => {
    const moved: ScopeTreeNode[] = [
      { id: 'top-space', kind: 'space', name: 'Loose Canvas' },
      { id: 'proj-a', kind: 'project', name: 'Project A', children: [{ id: 'a-2', kind: 'space', name: 'A Two' }] },
      { id: 'a-1', kind: 'space', name: 'A One' } // moved out to root
    ]
    expect(memoryScopeForSpace(moved, 'a-1')).toEqual({ kind: 'space', spaceId: 'a-1' })
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
