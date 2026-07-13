// Shapes mirror the Go backend JSON (server-go/internal/auth, /documents).
export interface User {
  id: string
  email: string
  createdAt: string
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  user: User
}

export interface DocumentMeta {
  id: string
  ownerId: string
  title: string
  createdAt: string
  updatedAt: string
}

/** Account-scoped sidebar tree (projects + idea spaces). Opaque to the server. */
export type WorkspaceTreeNode = {
  id: string
  kind: 'project' | 'space'
  name: string
  children?: WorkspaceTreeNode[]
  /** Internal sync-room id for spaces when signed in. */
  docId?: string
}

export interface WorkspacePayload {
  tree: WorkspaceTreeNode[]
  updatedAt?: string
}

/** Inspiration-card search hit (mirrors Go /search + Node relay). */
export interface SearchResult {
  title: string
  url: string
  snippet?: string
}

/** Page og:description / og:image from Go /url-meta. */
export interface UrlMeta {
  description?: string
  image?: string
}
