// H4 — Backend API client (transport only).
//
// Thin fetch wrapper implementing the MemoryClient interface against the routes
// in PROJECT_MEMORY_CONTRACTS.md. Upload uses multipart/form-data. The auth
// header is attached the same way the existing API client does
// (Authorization: Bearer <token> from getToken()). No retries, no caching, no
// retrieval, no AI selection — transport only. Non-2xx surfaces as MemoryApiError.

import type {
  CreateMemoryClient,
  MemoryClient,
  MemoryClientDeps,
  ProjectInstructions,
  ProjectMemoryFile,
  ProjectMemoryScope,
  UploadFileInput
} from './types'
import { MemoryApiError, scopeKey } from './types'

// Re-exported so existing `import { MemoryApiError } from './client'` call
// sites keep working — the real implementation lives in ./types (see there).
export { MemoryApiError }

export const createMemoryClient: CreateMemoryClient = (deps) => {
  const baseUrl = deps.baseUrl.replace(/\/+$/, '')
  const fetchImpl =
    deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init))

  const authHeaders = (): Record<string, string> => {
    const token = deps.getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  const url = (path: string) => baseUrl + path

  const scopePath = (scope: ProjectMemoryScope): string => {
    const { scopeKind, scopeId } = scopeKey(scope)
    return `/project-memory/${encodeURIComponent(scopeKind)}/${encodeURIComponent(scopeId)}`
  }

  /** Throw MemoryApiError (with the server's `error` message if present) on non-2xx. */
  const ensureOk = async (res: Response): Promise<void> => {
    if (res.ok) return
    let message = `request failed (${res.status})`
    try {
      const body = await res.json()
      if (body?.error) message = body.error
    } catch {
      /* non-JSON body — keep the generic message */
    }
    throw new MemoryApiError(res.status, message)
  }

  const client: MemoryClient = {
    async listFiles(scope) {
      const res = await fetchImpl(url(`${scopePath(scope)}/files`), {
        method: 'GET',
        headers: { ...authHeaders() }
      })
      await ensureOk(res)
      return (await res.json()) as ProjectMemoryFile[]
    },

    async uploadFile(scope, input) {
      const fd = new FormData()
      fd.append('file', input.blob, input.name)
      fd.append('name', input.name)
      fd.append('mimeType', input.mimeType)
      fd.append('title', input.title)
      fd.append('description', input.description)
      if (input.extractedText !== undefined) {
        fd.append('extractedText', input.extractedText)
      }
      // Do NOT set Content-Type — fetch sets the multipart boundary itself.
      const res = await fetchImpl(url(`${scopePath(scope)}/files`), {
        method: 'POST',
        headers: { ...authHeaders() },
        body: fd
      })
      await ensureOk(res)
      return (await res.json()) as ProjectMemoryFile
    },

    async deleteFile(fileId) {
      const res = await fetchImpl(url(`/project-memory/files/${encodeURIComponent(fileId)}`), {
        method: 'DELETE',
        headers: { ...authHeaders() }
      })
      await ensureOk(res)
    },

    async getText(fileId) {
      const res = await fetchImpl(url(`/project-memory/files/${encodeURIComponent(fileId)}/text`), {
        method: 'GET',
        headers: { ...authHeaders() }
      })
      await ensureOk(res)
      const body = (await res.json()) as { text: string; truncated: boolean }
      return body.text
    },

    async getBlob(fileId) {
      const res = await fetchImpl(url(`/project-memory/files/${encodeURIComponent(fileId)}/blob`), {
        method: 'GET',
        headers: { ...authHeaders() }
      })
      await ensureOk(res)
      return await res.blob()
    },

    async getInstructions(scope) {
      const res = await fetchImpl(url(`${scopePath(scope)}/instructions`), {
        method: 'GET',
        headers: { ...authHeaders() }
      })
      await ensureOk(res)
      return (await res.json()) as ProjectInstructions
    },

    async putInstructions(scope, ins) {
      const res = await fetchImpl(url(`${scopePath(scope)}/instructions`), {
        method: 'PUT',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(ins)
      })
      await ensureOk(res)
    },

    async deleteScope(scope) {
      const res = await fetchImpl(url(scopePath(scope)), {
        method: 'DELETE',
        headers: { ...authHeaders() }
      })
      await ensureOk(res)
    }
  }

  return client
}
