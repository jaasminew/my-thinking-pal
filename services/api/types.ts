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
