import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient } from '../../../services/api/client'
import { apiBaseUrl, apiEnabled, wsUrl } from '../../../services/api/config'
import { sharedTokenStore } from '../../../services/api/tokens'
import type { DocumentMeta, User } from '../../../services/api/types'
import { loadJSON, saveJSON } from './persist'

export interface SyncParams {
  baseUrl: string
  token: string
  docId: string
}

export interface Backend {
  enabled: boolean
  ready: boolean
  user: User | null
  error: string
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Ensure a server document exists for a local space; returns its id (or null). */
  ensureDoc: (spaceId: string, title: string) => Promise<string | null>
  /** Sync params for a space, or null when not authed / not yet mapped. */
  syncFor: (spaceId: string) => SyncParams | null
  /** Backend /stt WebSocket URL (with token), or null when not authed. */
  sttUrl: () => string | null
  /** Refresh/validate auth before opening non-HTTP transports such as /stt. */
  refreshAuth: () => Promise<boolean>

  /** The user's server documents (loaded when signed in). */
  documents: DocumentMeta[]
  /** True once the document list has been fetched at least once (so callers can
   *  avoid auto-creating duplicates on a device that already has documents). */
  docsLoaded: boolean
  refreshDocuments: () => Promise<void>
  /** The server document id currently bound to a local space (or undefined). */
  docIdFor: (spaceId: string) => string | undefined
  /** Bind a local space to a server document. adopt=true means take the doc's
   *  content (existing/blank) rather than seeding it from this device's canvas. */
  bindDoc: (spaceId: string, docId: string, adopt?: boolean) => void
  /** Whether a space adopted its doc (so the board should NOT seed from local). */
  isAdopted: (spaceId: string) => boolean
  createDoc: (title: string) => Promise<DocumentMeta | null>
  renameDoc: (docId: string, title: string) => Promise<void>
  deleteDoc: (docId: string) => Promise<void>
}

const DOCMAP_KEY = 'tp.docmap' // spaceId -> server document id

// Central hook for backend auth + per-space document mapping. When the backend
// isn't configured (VITE_API_URL empty) everything is inert and the app stays in
// local-only mode.
export function useBackend(): Backend {
  const enabled = apiEnabled()
  const client = useMemo(() => (enabled ? new ApiClient({ baseUrl: apiBaseUrl() }) : null), [enabled])
  const [user, setUser] = useState<User | null>(() => {
    if (!enabled) return null
    const store = sharedTokenStore()
    return store.hasSession ? store.loadUser() : null
  })
  const [ready, setReady] = useState(!enabled)
  const [error, setError] = useState('')
  const [docMap, setDocMap] = useState<Record<string, string>>(() => loadJSON(DOCMAP_KEY, {}))
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [docsLoaded, setDocsLoaded] = useState(false)
  const inflight = useRef<Map<string, Promise<string | null>>>(new Map())

  useEffect(() => saveJSON(DOCMAP_KEY, docMap), [docMap])

  // Restore session on load: validate stored tokens (refresh when access expired).
  useEffect(() => {
    if (!client) return
    let cancelled = false
    void (async () => {
      const me = await client.restoreSession()
      if (!cancelled) setUser(me)
      if (!cancelled) setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [client])

  const login = useCallback(
    async (email: string, password: string) => {
      if (!client) return
      setError('')
      try {
        const pair = await client.login(email, password)
        setUser(pair.user)
      } catch (e: any) {
        setError(e?.message || 'login failed')
        throw e
      }
    },
    [client]
  )

  const register = useCallback(
    async (email: string, password: string) => {
      if (!client) return
      setError('')
      try {
        const pair = await client.register(email, password)
        setUser(pair.user)
      } catch (e: any) {
        setError(e?.message || 'registration failed')
        throw e
      }
    },
    [client]
  )

  const logout = useCallback(async () => {
    if (!client) return
    await client.logout()
    setUser(null)
    setDocuments([])
    setDocsLoaded(false)
    setDocMap({}) // mapping is per-account; drop it so the next user starts clean
  }, [client])

  const refreshDocuments = useCallback(async () => {
    if (!client || !user) return
    try {
      setDocuments(await client.listDocuments())
    } catch {
      /* leave the previous list on transient failures */
    } finally {
      setDocsLoaded(true)
    }
  }, [client, user])

  // Keep the document list fresh whenever a user is present.
  useEffect(() => {
    if (user) void refreshDocuments()
  }, [user, refreshDocuments])

  const ensureDoc = useCallback(
    async (spaceId: string, title: string): Promise<string | null> => {
      if (!client || !user) return null
      const existing = docMap[spaceId]
      if (existing) return existing
      const pending = inflight.current.get(spaceId)
      if (pending) return pending
      const p = (async () => {
        try {
          const doc = await client.createDocument(title || 'Untitled')
          setDocMap((m) => ({ ...m, [spaceId]: doc.id }))
          return doc.id
        } catch {
          return null
        } finally {
          inflight.current.delete(spaceId)
        }
      })()
      inflight.current.set(spaceId, p)
      return p
    },
    [client, user, docMap]
  )

  const syncFor = useCallback(
    (spaceId: string): SyncParams | null => {
      if (!client || !user) return null
      const docId = docMap[spaceId]
      const token = client.tokens.access
      if (!docId || !token) return null
      return { baseUrl: client.baseUrl, token, docId }
    },
    [client, user, docMap]
  )

  const sttUrl = useCallback((): string | null => {
    if (!client) return null
    const token = client.tokens.access
    return token ? wsUrl(client.baseUrl, '/stt', token) : null
  }, [client])

  const refreshAuth = useCallback(async (): Promise<boolean> => {
    if (!client) return false
    const me = await client.restoreSession()
    setUser(me)
    return !!me
  }, [client])

  const [adopted, setAdopted] = useState<Record<string, boolean>>({})
  const docIdFor = useCallback((spaceId: string) => docMap[spaceId], [docMap])
  const isAdopted = useCallback((spaceId: string) => !!adopted[spaceId], [adopted])

  const bindDoc = useCallback((spaceId: string, docId: string, adopt = false) => {
    setDocMap((m) => ({ ...m, [spaceId]: docId }))
    setAdopted((a) => ({ ...a, [spaceId]: adopt }))
  }, [])

  const createDoc = useCallback(
    async (title: string): Promise<DocumentMeta | null> => {
      if (!client || !user) return null
      try {
        const doc = await client.createDocument(title || 'Untitled')
        setDocuments((d) => [doc, ...d])
        return doc
      } catch {
        return null
      }
    },
    [client, user]
  )

  const renameDoc = useCallback(
    async (docId: string, title: string) => {
      if (!client || !user) return
      await client.patchDocument(docId, title)
      setDocuments((d) => d.map((x) => (x.id === docId ? { ...x, title } : x)))
    },
    [client, user]
  )

  const deleteDoc = useCallback(
    async (docId: string) => {
      if (!client || !user) return
      await client.deleteDocument(docId)
      setDocuments((d) => d.filter((x) => x.id !== docId))
      // Unbind any local space that pointed at the now-deleted document.
      setDocMap((m) => {
        const next: Record<string, string> = {}
        for (const [space, id] of Object.entries(m)) if (id !== docId) next[space] = id
        return next
      })
    },
    [client, user]
  )

  // Memoize so the returned object is a STABLE reference across renders unless
  // its actual contents change. Consumers that (incorrectly) depend on the whole
  // `backend` object in an effect then won't spin — see the /documents refresh
  // loop this originally caused.
  return useMemo(
    () => ({
      enabled,
      ready,
      user,
      error,
      login,
      register,
      logout,
      ensureDoc,
      syncFor,
      sttUrl,
      refreshAuth,
      documents,
      docsLoaded,
      refreshDocuments,
      docIdFor,
      bindDoc,
      isAdopted,
      createDoc,
      renameDoc,
      deleteDoc
    }),
    [
      enabled,
      ready,
      user,
      error,
      login,
      register,
      logout,
      ensureDoc,
      syncFor,
      sttUrl,
      refreshAuth,
      documents,
      docsLoaded,
      refreshDocuments,
      docIdFor,
      bindDoc,
      isAdopted,
      createDoc,
      renameDoc,
      deleteDoc
    ]
  )
}
