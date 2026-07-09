import { describe, expect, it } from 'vitest'
// `fake-indexeddb/auto` installs `indexedDB` + `IDBKeyRange` (+ the rest of the
// IDB surface) onto the global before any test runs, so the store — which reads
// the global `indexedDB` — sees an in-memory database. Each test uses a fresh DB
// name for isolation.
import 'fake-indexeddb/auto'
import { createLocalStore } from './local-store'
import type {
  ProjectInstructions,
  ProjectMemoryFile,
  ProjectMemoryScope
} from './types'

const projectScope: ProjectMemoryScope = { kind: 'project', projectId: 'proj-1' }
const spaceScope: ProjectMemoryScope = { kind: 'space', spaceId: 'space-1' }

let counter = 0
const uniqueDb = () => `pm-test-${Date.now()}-${counter++}`

const file = (id: string, over: Partial<ProjectMemoryFile> = {}): ProjectMemoryFile => ({
  id,
  scopeKind: 'space',
  scopeId: 'space-1',
  name: `${id}.md`,
  mimeType: 'text/markdown',
  size: 100,
  title: `Title ${id}`,
  description: `Description ${id}`,
  status: 'indexed',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over
})

describe('createLocalStore — file lifecycle', () => {
  it('creates a file, lists it, and reads it back', async () => {
    const store = createLocalStore(uniqueDb())
    const meta = file('f1', { scopeKind: 'space', scopeId: 'space-1' })
    await store.createFile(meta)

    const listed = await store.listFiles(spaceScope)
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe('f1')

    const got = await store.getFile('f1')
    expect(got).toEqual(meta)
  })

  it('lists only files in the queried scope', async () => {
    const store = createLocalStore(uniqueDb())
    await store.createFile(file('s1', { scopeKind: 'space', scopeId: 'space-1' }))
    await store.createFile(file('p1', { scopeKind: 'project', scopeId: 'proj-1' }))
    await store.createFile(file('p2', { scopeKind: 'project', scopeId: 'proj-1' }))

    expect((await store.listFiles(spaceScope)).map((f) => f.id)).toEqual(['s1'])
    expect((await store.listFiles(projectScope)).map((f) => f.id)).toEqual(['p1', 'p2'])
  })

  it('returns newest first (createdAt desc)', async () => {
    const store = createLocalStore(uniqueDb())
    await store.createFile(file('old', { createdAt: '2026-01-01T00:00:00Z' }))
    await store.createFile(file('new', { createdAt: '2026-06-01T00:00:00Z' }))
    await store.createFile(file('mid', { createdAt: '2026-03-01T00:00:00Z' }))

    expect((await store.listFiles(spaceScope)).map((f) => f.id)).toEqual(['new', 'mid', 'old'])
  })

  it('updateFile overwrites the full row (status + title transitions)', async () => {
    const store = createLocalStore(uniqueDb())
    await store.createFile(file('f1', { status: 'queued' }))
    await store.updateFile(file('f1', { status: 'failed', error: 'boom', title: 'New Title' }))

    const got = await store.getFile('f1')
    expect(got?.status).toBe('failed')
    expect(got?.error).toBe('boom')
    expect(got?.title).toBe('New Title')
  })

  it('getFile returns undefined for a missing id', async () => {
    const store = createLocalStore(uniqueDb())
    expect(await store.getFile('nope')).toBeUndefined()
  })

  it('deleteFile removes the row, its text, and its blob; missing id is a no-op', async () => {
    const store = createLocalStore(uniqueDb())
    await store.createFile(file('f1'))
    await store.putText('f1', 'the text')
    await store.putBlob('f1', new Blob(['bytes'], { type: 'text/plain' }))

    await store.deleteFile('f1')
    expect(await store.getFile('f1')).toBeUndefined()
    expect(await store.getText('f1')).toBeUndefined()
    expect(await store.getBlob('f1')).toBeUndefined()

    // No-op on already-deleted id.
    await expect(store.deleteFile('f1')).resolves.toBeUndefined()
  })
})

describe('createLocalStore — text & blob storage', () => {
  it('round-trips extracted text', async () => {
    const store = createLocalStore(uniqueDb())
    await store.putText('t1', 'hello world')
    expect(await store.getText('t1')).toBe('hello world')
  })

  it('getText returns undefined when no text was stored', async () => {
    const store = createLocalStore(uniqueDb())
    expect(await store.getText('missing')).toBeUndefined()
  })

  it('round-trips a Blob and reads its contents back', async () => {
    const store = createLocalStore(uniqueDb())
    const original = new Blob(['raw bytes here'], { type: 'application/octet-stream' })
    await store.putBlob('b1', original)

    const got = await store.getBlob('b1')
    expect(got).toBeInstanceOf(Blob)
    expect(got!.type).toBe('application/octet-stream')
    expect(await got!.text()).toBe('raw bytes here')
  })

  it('getBlob returns undefined when no blob was stored', async () => {
    const store = createLocalStore(uniqueDb())
    expect(await store.getBlob('missing')).toBeUndefined()
  })
})

describe('createLocalStore — instructions', () => {
  it('returns undefined when a scope has never saved instructions', async () => {
    const store = createLocalStore(uniqueDb())
    expect(await store.getInstructions(spaceScope)).toBeUndefined()
  })

  it('round-trips instructions per scope', async () => {
    const store = createLocalStore(uniqueDb())
    const spaceIns: ProjectInstructions = {
      transcriptionSummary: 'summarize tersely',
      coCreation: 'be concise',
      aiCommand: 'use bullet points'
    }
    const projectIns: ProjectInstructions = {
      transcriptionSummary: 'project sum',
      coCreation: 'project co',
      aiCommand: 'project cmd'
    }

    await store.putInstructions(spaceScope, spaceIns)
    await store.putInstructions(projectScope, projectIns)

    expect(await store.getInstructions(spaceScope)).toEqual(spaceIns)
    expect(await store.getInstructions(projectScope)).toEqual(projectIns)
  })

  it('putInstructions upserts (overwrites a previous save)', async () => {
    const store = createLocalStore(uniqueDb())
    await store.putInstructions(spaceScope, {
      transcriptionSummary: 'a',
      coCreation: 'b',
      aiCommand: 'c'
    })
    await store.putInstructions(spaceScope, {
      transcriptionSummary: 'A',
      coCreation: 'B',
      aiCommand: 'C'
    })
    expect(await store.getInstructions(spaceScope)).toEqual({
      transcriptionSummary: 'A',
      coCreation: 'B',
      aiCommand: 'C'
    })
  })
})

describe('createLocalStore — deleteScope (orphan cleanup)', () => {
  it('removes every file (row + text + blob) and the instructions of a scope', async () => {
    const store = createLocalStore(uniqueDb())
    await store.createFile(file('f1', { scopeKind: 'space', scopeId: 'space-1' }))
    await store.createFile(file('f2', { scopeKind: 'space', scopeId: 'space-1' }))
    await store.putText('f1', 't1')
    await store.putBlob('f2', new Blob(['x']))
    await store.putInstructions(spaceScope, {
      transcriptionSummary: 's',
      coCreation: 'c',
      aiCommand: 'a'
    })
    // A file in a different scope must survive.
    await store.createFile(file('p1', { scopeKind: 'project', scopeId: 'proj-1' }))

    await store.deleteScope(spaceScope)

    expect(await store.listFiles(spaceScope)).toEqual([])
    expect(await store.getText('f1')).toBeUndefined()
    expect(await store.getBlob('f2')).toBeUndefined()
    expect(await store.getInstructions(spaceScope)).toBeUndefined()
    // Untouched scope is intact.
    expect((await store.listFiles(projectScope)).map((f) => f.id)).toEqual(['p1'])
  })

  it('is a no-op on an empty scope', async () => {
    const store = createLocalStore(uniqueDb())
    await expect(store.deleteScope(spaceScope)).resolves.toBeUndefined()
    expect(await store.listFiles(spaceScope)).toEqual([])
  })
})
