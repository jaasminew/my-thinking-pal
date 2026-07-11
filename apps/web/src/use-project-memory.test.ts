// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useProjectMemory } from './use-project-memory'
import type { ScopeTreeNode } from '../../../services/project-memory/scope'
import type {
  LocalStore,
  ProjectInstructions,
  ProjectMemoryFile,
  ProjectMemoryScope
} from '../../../services/project-memory/types'
import { scopeKey } from '../../../services/project-memory/types'

const tree: ScopeTreeNode[] = [{ id: 'space-1', kind: 'space', name: 'Canvas' }]

function makeLocalStore(initial: ProjectInstructions) {
  let files: ProjectMemoryFile[] = []
  let instructions = initial
  const getInstructions = vi.fn(async () => instructions)
  const store: LocalStore = {
    async createFile(meta) {
      files.push(meta)
    },
    async listFiles() {
      return files
    },
    async getFile(id) {
      return files.find((f) => f.id === id)
    },
    async updateFile(meta) {
      files = files.map((f) => (f.id === meta.id ? meta : f))
    },
    async deleteFile(id) {
      files = files.filter((f) => f.id !== id)
    },
    async putText() {},
    async getText() {
      return undefined
    },
    async putBlob() {},
    async getBlob() {
      return undefined
    },
    getInstructions,
    async putInstructions(_scope, ins) {
      instructions = ins
    },
    async deleteScope() {}
  }
  return { store, getInstructions, setInstructions: (ins: ProjectInstructions) => (instructions = ins) }
}

// Regression test for the bug found reviewing H3/hook integration: uploadFiles
// (and delete/retry) must NOT refetch instructions, or an unsaved edit typed
// into the modal's Instructions tab gets silently discarded the moment the
// user drags in a file. See use-project-memory.ts `refreshFiles` vs `refresh`.
describe('useProjectMemory — file mutations do not clobber instructions', () => {
  it('does not re-fetch instructions after uploadFiles resolves', async () => {
    const { store, getInstructions } = makeLocalStore({
      transcriptionSummary: 'persisted',
      coCreation: '',
      aiCommand: ''
    })
    const { result } = renderHook(() =>
      useProjectMemory(tree, 'space-1', { localStore: store, client: null, extractText: null })
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(getInstructions).toHaveBeenCalledTimes(1) // initial scope-entry load

    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    await act(async () => {
      await result.current.canvas!.uploadFiles([file])
    })

    // The file mutation refreshed the file list but must not have re-fetched
    // instructions — that would clobber any unsaved draft in the modal.
    expect(getInstructions).toHaveBeenCalledTimes(1)
    expect(result.current.instructions.transcriptionSummary).toBe('persisted')
  })

  it('does not re-fetch instructions after deleteFile resolves', async () => {
    const { store, getInstructions } = makeLocalStore({
      transcriptionSummary: 'keep me',
      coCreation: '',
      aiCommand: ''
    })
    const { result } = renderHook(() =>
      useProjectMemory(tree, 'space-1', { localStore: store, client: null, extractText: null })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.canvas!.deleteFile('nonexistent')
    })

    expect(getInstructions).toHaveBeenCalledTimes(1)
    expect(result.current.instructions.transcriptionSummary).toBe('keep me')
  })

  it('saveInstructions still updates instructions and toggles busy', async () => {
    const { store } = makeLocalStore({ transcriptionSummary: '', coCreation: '', aiCommand: '' })
    const { result } = renderHook(() =>
      useProjectMemory(tree, 'space-1', { localStore: store, client: null, extractText: null })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.canvas!.saveInstructions({ transcriptionSummary: 'new', coCreation: '', aiCommand: '' })
    })

    expect(result.current.busy).toBe(false)
    expect(result.current.canvas!.instructionsSaved).toBe(true)
    expect(result.current.instructions.transcriptionSummary).toBe('new')
  })
})

// Two-level memory: a canvas nested in a project reads BOTH buckets.
describe('useProjectMemory — two-level scopes (merged semantics)', () => {
  const nestedTree: ScopeTreeNode[] = [
    {
      id: 'proj-1',
      kind: 'project',
      name: 'Project One',
      children: [{ id: 'space-1', kind: 'space', name: 'Canvas One' }]
    }
  ]

  // A store whose instructions differ per scope, so merge order is observable.
  function makePerScopeStore() {
    const byScope = new Map<string, ProjectInstructions>([
      ['project:proj-1', { transcriptionSummary: '', coCreation: 'project rule', aiCommand: '' }],
      ['space:space-1', { transcriptionSummary: '', coCreation: 'canvas rule', aiCommand: '' }]
    ])
    const filesByScope = new Map<string, ProjectMemoryFile[]>()
    const key = (s: ProjectMemoryScope) => {
      const { scopeKind, scopeId } = scopeKey(s)
      return `${scopeKind}:${scopeId}`
    }
    const store: LocalStore = {
      async createFile(meta) {
        const k = `${meta.scopeKind}:${meta.scopeId}`
        filesByScope.set(k, [...(filesByScope.get(k) ?? []), meta])
      },
      async listFiles(scope) {
        return filesByScope.get(key(scope)) ?? []
      },
      async getFile() {
        return undefined
      },
      async updateFile(meta) {
        const k = `${meta.scopeKind}:${meta.scopeId}`
        filesByScope.set(k, (filesByScope.get(k) ?? []).map((f) => (f.id === meta.id ? meta : f)))
      },
      async deleteFile() {},
      async putText() {},
      async getText() {
        return undefined
      },
      async putBlob() {},
      async getBlob() {
        return undefined
      },
      async getInstructions(scope) {
        return byScope.get(key(scope))
      },
      async putInstructions(scope, ins) {
        byScope.set(key(scope), ins)
      },
      async deleteScope() {}
    }
    return store
  }

  it('exposes both buckets and merges instructions project-first', async () => {
    // Created OUTSIDE the render callback: a fresh store per render would give
    // the refresh effect a new dependency identity every render → render loop.
    const store = makePerScopeStore()
    const { result } = renderHook(() =>
      useProjectMemory(nestedTree, 'space-1', { localStore: store, client: null, extractText: null })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.project?.name).toBe('Project One')
    expect(result.current.canvas?.name).toBe('Canvas One')
    await waitFor(() =>
      expect(result.current.instructions.coCreation).toBe('project rule\n\ncanvas rule')
    )
  })

  it('a top-level canvas has no project bucket', async () => {
    const { store } = makeLocalStore({ transcriptionSummary: '', coCreation: '', aiCommand: '' })
    const { result } = renderHook(() =>
      useProjectMemory(tree, 'space-1', { localStore: store, client: null, extractText: null })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.project).toBeNull()
    expect(result.current.canvas?.scope).toEqual({ kind: 'space', spaceId: 'space-1' })
  })
})
