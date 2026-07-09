import { describe, expect, it, vi } from 'vitest'
import { createMemoryClient, MemoryApiError } from './client'
import type { MemoryClientDeps, ProjectMemoryScope } from './types'

type Call = { input: string; init?: RequestInit }

/** Builds a mock fetchImpl that records calls and returns canned responses. */
function mockFetch(
  respond: (input: string, init?: RequestInit) => { status: number; body?: unknown }
) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(
    async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init })
      const { status, body } = respond(input, init)
      const payload = body === undefined ? null : JSON.stringify(body)
      return new Response(payload, {
        status,
        headers: { 'content-type': 'application/json' }
      })
    }
  )
  return { fetchImpl, calls }
}

const deps = (fetchImpl: MemoryClientDeps['fetchImpl'], token: string | null = 'tok-123') => ({
  baseUrl: 'https://api.test/v1',
  getToken: () => token,
  fetchImpl
})

const projectScope: ProjectMemoryScope = { kind: 'project', projectId: 'p1' }
const spaceScope: ProjectMemoryScope = { kind: 'space', spaceId: 's1' }

const initOf = (c: Call) => c.init!
const headersOf = (c: Call) => c.init!.headers as Record<string, string>

describe('createMemoryClient — listFiles', () => {
  it('GETs /{scope}/files with the Bearer header and returns the array', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: [{ id: 'f1' }] }))
    const c = createMemoryClient(deps(fetchImpl))
    const out = await c.listFiles(projectScope)
    expect(out).toEqual([{ id: 'f1' }])
    expect(calls[0].input).toBe('https://api.test/v1/project-memory/project/p1/files')
    expect(initOf(calls[0]).method).toBe('GET')
    expect(headersOf(calls[0]).Authorization).toBe('Bearer tok-123')
  })
})

describe('createMemoryClient — uploadFile', () => {
  it('POSTs multipart/form-data with file + all fields to /{scope}/files', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 201, body: { id: 'new' } }))
    const c = createMemoryClient(deps(fetchImpl))
    const blob = new Blob(['hello'], { type: 'text/plain' })
    const out = await c.uploadFile(spaceScope, {
      blob,
      name: 'note.txt',
      mimeType: 'text/plain',
      title: 'Note',
      description: 'a note',
      extractedText: 'hello'
    })
    expect(out).toEqual({ id: 'new' })

    const call = calls[0]
    expect(call.input).toBe('https://api.test/v1/project-memory/space/s1/files')
    expect(initOf(call).method).toBe('POST')
    expect(headersOf(call).Authorization).toBe('Bearer tok-123')
    // No manual Content-Type — fetch sets the multipart boundary.
    expect(headersOf(call)['content-type']).toBeUndefined()

    const fd = initOf(call).body as FormData
    expect(fd.get('name')).toBe('note.txt')
    expect(fd.get('mimeType')).toBe('text/plain')
    expect(fd.get('title')).toBe('Note')
    expect(fd.get('description')).toBe('a note')
    expect(fd.get('extractedText')).toBe('hello')
    const file = fd.get('file') as File
    expect(file).toBeInstanceOf(Blob)
    expect(file.name).toBe('note.txt')
  })

  it('omits extractedText from the form when not provided', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 201, body: { id: 'new' } }))
    const c = createMemoryClient(deps(fetchImpl))
    await c.uploadFile(spaceScope, {
      blob: new Blob(['x']),
      name: 'a.txt',
      mimeType: 'text/plain',
      title: 'A',
      description: 'd'
    })
    const fd = initOf(calls[0]).body as FormData
    expect(fd.get('extractedText')).toBeNull()
  })
})

describe('createMemoryClient — deleteFile', () => {
  it('DELETEs /files/{id}', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 204 }))
    const c = createMemoryClient(deps(fetchImpl))
    await c.deleteFile('f-42')
    expect(calls[0].input).toBe('https://api.test/v1/project-memory/files/f-42')
    expect(initOf(calls[0]).method).toBe('DELETE')
    expect(headersOf(calls[0]).Authorization).toBe('Bearer tok-123')
  })

  it('URL-encodes the file id', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 204 }))
    const c = createMemoryClient(deps(fetchImpl))
    await c.deleteFile('a b/c')
    expect(calls[0].input).toBe('https://api.test/v1/project-memory/files/a%20b%2Fc')
  })
})

describe('createMemoryClient — getText', () => {
  it('GETs /files/{id}/text and returns the text field', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: { text: 'body', truncated: false } }))
    const c = createMemoryClient(deps(fetchImpl))
    const text = await c.getText('f1')
    expect(text).toBe('body')
    expect(calls[0].input).toBe('https://api.test/v1/project-memory/files/f1/text')
    expect(initOf(calls[0]).method).toBe('GET')
  })
})

describe('createMemoryClient — getInstructions', () => {
  it('GETs /{scope}/instructions and returns ProjectInstructions', async () => {
    const ins = { transcriptionSummary: 's', coCreation: 'c', aiCommand: 'a' }
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: ins }))
    const c = createMemoryClient(deps(fetchImpl))
    const out = await c.getInstructions(projectScope)
    expect(out).toEqual(ins)
    expect(calls[0].input).toBe('https://api.test/v1/project-memory/project/p1/instructions')
    expect(initOf(calls[0]).method).toBe('GET')
  })
})

describe('createMemoryClient — putInstructions', () => {
  it('PUTs JSON to /{scope}/instructions with the right content-type', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 204 }))
    const c = createMemoryClient(deps(fetchImpl))
    const ins = { transcriptionSummary: 's', coCreation: 'c', aiCommand: 'a' }
    await c.putInstructions(spaceScope, ins)
    const call = calls[0]
    expect(call.input).toBe('https://api.test/v1/project-memory/space/s1/instructions')
    expect(initOf(call).method).toBe('PUT')
    expect(headersOf(call)['content-type']).toBe('application/json')
    expect(headersOf(call).Authorization).toBe('Bearer tok-123')
    expect(initOf(call).body).toBe(JSON.stringify(ins))
  })
})

describe('createMemoryClient — deleteScope', () => {
  it('DELETEs /{scope}', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 204 }))
    const c = createMemoryClient(deps(fetchImpl))
    await c.deleteScope(projectScope)
    expect(calls[0].input).toBe('https://api.test/v1/project-memory/project/p1')
    expect(initOf(calls[0]).method).toBe('DELETE')
    expect(headersOf(calls[0]).Authorization).toBe('Bearer tok-123')
  })
})

describe('createMemoryClient — auth + base URL', () => {
  it('omits the Authorization header when getToken() returns null', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: [] }))
    const c = createMemoryClient(deps(fetchImpl, null))
    await c.listFiles(spaceScope)
    expect(headersOf(calls[0]).Authorization).toBeUndefined()
  })

  it('strips a trailing slash from baseUrl', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: [] }))
    const c = createMemoryClient({ baseUrl: 'https://api.test/v1///', getToken: () => 't', fetchImpl })
    await c.listFiles(spaceScope)
    expect(calls[0].input).toBe('https://api.test/v1/project-memory/space/s1/files')
  })
})

describe('createMemoryClient — error handling', () => {
  it('throws MemoryApiError with status + server message on non-2xx', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 413, body: { error: 'file too large' } }))
    const c = createMemoryClient(deps(fetchImpl))
    await expect(c.uploadFile(spaceScope, {
      blob: new Blob(['x']),
      name: 'a.txt',
      mimeType: 'text/plain',
      title: 'A',
      description: 'd'
    })).rejects.toMatchObject({ name: 'MemoryApiError', status: 413, message: 'file too large' })
  })

  it('falls back to a generic message when the error body is not JSON', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      new Response('plain text', { status: 500 })
    )
    const c = createMemoryClient(deps(fetchImpl))
    await expect(c.listFiles(spaceScope)).rejects.toBeInstanceOf(MemoryApiError)
  })
})
