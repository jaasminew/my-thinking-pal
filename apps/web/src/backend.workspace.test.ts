import { describe, expect, it } from 'vitest'
import { docMapFromTree, listSpaces, stampDocIds, type WorkspaceTreeNode } from './backend'

const tree: WorkspaceTreeNode[] = [
  {
    id: 'p1',
    kind: 'project',
    name: 'Proj',
    children: [
      { id: 's1', kind: 'space', name: 'A', docId: 'd1' },
      { id: 's2', kind: 'space', name: 'B' }
    ]
  },
  { id: 's3', kind: 'space', name: 'C', docId: 'd3' }
]

describe('workspace tree helpers', () => {
  it('docMapFromTree collects space docIds', () => {
    expect(docMapFromTree(tree)).toEqual({ s1: 'd1', s3: 'd3' })
  })

  it('listSpaces walks projects', () => {
    expect(listSpaces(tree).map((s) => s.id)).toEqual(['s1', 's2', 's3'])
  })

  it('stampDocIds fills missing space docIds', () => {
    const stamped = stampDocIds(tree, { s2: 'd2' })
    expect(docMapFromTree(stamped)).toEqual({ s1: 'd1', s2: 'd2', s3: 'd3' })
  })
})
