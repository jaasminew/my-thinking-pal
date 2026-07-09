// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useProjectMemory } from './use-project-memory'
import type { ScopeTreeNode } from '../../../services/project-memory/scope'
import type { LocalStore, ProjectInstructions, ProjectMemoryFile } from '../../../services/project-memory/types'

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
      await result.current.uploadFiles([file])
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
      await result.current.deleteFile('nonexistent')
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
      await result.current.saveInstructions({ transcriptionSummary: 'new', coCreation: '', aiCommand: '' })
    })

    expect(result.current.busy).toBe(false)
    expect(result.current.instructionsSaved).toBe(true)
    expect(result.current.instructions.transcriptionSummary).toBe('new')
  })
})
