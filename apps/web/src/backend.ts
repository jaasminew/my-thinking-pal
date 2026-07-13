import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient } from '../../../services/api/client'
import { apiBaseUrl, apiEnabled, wsUrl } from '../../../services/api/config'
import { sharedTokenStore } from '../../../services/api/tokens'
import type { User, WorkspaceTreeNode } from '../../../services/api/types'
import type { SearchResult, UrlMeta } from '../../../services/api/types'
import { loadJSON, saveJSON } from './persist'

export interface SyncParams {
  baseUrl: string
  token: string
  docId: string
}

export type { WorkspaceTreeNode }

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
  /** Force-refresh auth before opening non-HTTP transports such as /stt. */
  refreshAuth: () => Promise<boolean>

  /** True once workspace has been pulled/pushed after sign-in (or local-only). */
  workspaceReady: boolean
  /** App calls this after finishing login-time workspace bootstrap. */
  markWorkspaceReady: () => void
  /** Fetch the account workspace (tree + updatedAt). */
  getWorkspace: () => Promise<{ tree: WorkspaceTreeNode[]; updatedAt: string }>
  /** Replace the account workspace tree (LWW); returns server updatedAt. */
  putWorkspace: (tree: WorkspaceTreeNode[]) => Promise<{ updatedAt: string }>
  /** The server document id currently bound to a local space (or undefined). */
  docIdFor: (spaceId: string) => string | undefined
  /** Bind a local space to a server document. adopt=true → take server content. */
  bindDoc: (spaceId: string, docId: string, adopt?: boolean) => void
  /** Replace the whole space→doc map (e.g. after applying a server workspace tree). */
  replaceDocMap: (map: Record<string, string>, adoptAll?: boolean) => void
  /** Whether a space adopted its doc (so the board should NOT seed from local). */
  isAdopted: (spaceId: string) => boolean
  createDoc: (title: string) => Promise<{ id: string; title: string } | null>
  renameDoc: (docId: string, title: string) => Promise<void>
  deleteDoc: (docId: string) => Promise<void>
  /** Auth-gated web search via Go /search (empty when logged out / local uses Vite). */
  search: (query: string, n?: number) => Promise<SearchResult[]>
  /** Auth-gated page metadata via Go /url-meta. */
  urlMeta: (pageUrl: string) => Promise<UrlMeta>
}

const DOCMAP_KEY = 'tp.docmap' // spaceId -> server document id

/** Collect spaceId → docId from a workspace tree. */
export function docMapFromTree(tree: WorkspaceTreeNode[]): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (nodes: WorkspaceTreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'space' && n.docId) out[n.id] = n.docId
      if (n.children?.length) walk(n.children)
    }
  }
  walk(tree)
  return out
}

/** Stamp docIds from a map onto space nodes (immutable). */
export function stampDocIds(tree: WorkspaceTreeNode[], map: Record<string, string>): WorkspaceTreeNode[] {
  return tree.map((n) => {
    if (n.kind === 'space') {
      const docId = map[n.id] ?? n.docId
      return docId ? { ...n, docId } : { ...n }
    }
    return {
      ...n,
      children: n.children ? stampDocIds(n.children, map) : n.children
    }
  })
}

/** List every space node (depth-first). */
export function listSpaces(tree: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
  const out: WorkspaceTreeNode[] = []
  const walk = (nodes: WorkspaceTreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'space') out.push(n)
      if (n.children?.length) walk(n.children)
    }
  }
  walk(tree)
  return out
}

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
  const [workspaceReady, setWorkspaceReady] = useState(!enabled)
  const [adopted, setAdopted] = useState<Record<string, boolean>>({})
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

  // Reset workspace readiness whenever the signed-in user changes.
  useEffect(() => {
    if (!enabled) {
      setWorkspaceReady(true)
      return
    }
    if (!user) {
      setWorkspaceReady(true)
      return
    }
    setWorkspaceReady(false)
  }, [enabled, user?.id])

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
    setWorkspaceReady(true)
    setDocMap({})
    setAdopted({})
  }, [client])

  const markWorkspaceReady = useCallback(() => setWorkspaceReady(true), [])

  const getWorkspace = useCallback(async (): Promise<{ tree: WorkspaceTreeNode[]; updatedAt: string }> => {
    if (!client || !user) return { tree: [], updatedAt: '' }
    const ws = await client.getWorkspace()
    return {
      tree: Array.isArray(ws.tree) ? ws.tree : [],
      updatedAt: ws.updatedAt || ''
    }
  }, [client, user])

  const putWorkspace = useCallback(
    async (tree: WorkspaceTreeNode[]): Promise<{ updatedAt: string }> => {
      if (!client || !user) return { updatedAt: '' }
      const ws = await client.putWorkspace(tree)
      return { updatedAt: ws.updatedAt || '' }
    },
    [client, user]
  )

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
    const me = await client.refreshSession()
    setUser(me)
    return !!me
  }, [client])

  const docIdFor = useCallback((spaceId: string) => docMap[spaceId], [docMap])
  const isAdopted = useCallback((spaceId: string) => !!adopted[spaceId], [adopted])

  const bindDoc = useCallback((spaceId: string, docId: string, adopt = false) => {
    setDocMap((m) => ({ ...m, [spaceId]: docId }))
    setAdopted((a) => ({ ...a, [spaceId]: adopt }))
  }, [])

  const replaceDocMap = useCallback((map: Record<string, string>, adoptAll = false) => {
    setDocMap(map)
    if (adoptAll) {
      const next: Record<string, boolean> = {}
      for (const spaceId of Object.keys(map)) next[spaceId] = true
      setAdopted(next)
    }
  }, [])

  const createDoc = useCallback(
    async (title: string): Promise<{ id: string; title: string } | null> => {
      if (!client || !user) return null
      try {
        const doc = await client.createDocument(title || 'Untitled')
        return { id: doc.id, title: doc.title }
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
    },
    [client, user]
  )

  const deleteDoc = useCallback(
    async (docId: string) => {
      if (!client || !user) return
      await client.deleteDocument(docId)
      setDocMap((m) => {
        const next: Record<string, string> = {}
        for (const [space, id] of Object.entries(m)) if (id !== docId) next[space] = id
        return next
      })
    },
    [client, user]
  )

  const search = useCallback(
    async (query: string, n = 1): Promise<SearchResult[]> => {
      if (!enabled) {
        try {
          const r = await fetch(`/api/search?q=${encodeURIComponent(query)}&n=${n}`)
          if (!r.ok) return []
          const data = (await r.json()) as { results?: SearchResult[] }
          return Array.isArray(data?.results) ? data.results : []
        } catch {
          return []
        }
      }
      if (!client || !user) return []
      try {
        return await client.search(query, n)
      } catch {
        return []
      }
    },
    [enabled, client, user]
  )

  const urlMeta = useCallback(
    async (pageUrl: string): Promise<UrlMeta> => {
      if (!enabled) {
        try {
          const r = await fetch(`/api/url-meta?url=${encodeURIComponent(pageUrl)}`)
          if (!r.ok) return {}
          return ((await r.json()) as UrlMeta) || {}
        } catch {
          return {}
        }
      }
      if (!client || !user) return {}
      try {
        return await client.urlMeta(pageUrl)
      } catch {
        return {}
      }
    },
    [enabled, client, user]
  )

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
      workspaceReady,
      markWorkspaceReady,
      getWorkspace,
      putWorkspace,
      docIdFor,
      bindDoc,
      replaceDocMap,
      isAdopted,
      createDoc,
      renameDoc,
      deleteDoc,
      search,
      urlMeta
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
      workspaceReady,
      markWorkspaceReady,
      getWorkspace,
      putWorkspace,
      docIdFor,
      bindDoc,
      replaceDocMap,
      isAdopted,
      createDoc,
      renameDoc,
      deleteDoc,
      search,
      urlMeta
    ]
  )
}
