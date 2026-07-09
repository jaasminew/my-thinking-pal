import type { DocumentMeta, TokenPair, User } from './types'
import { sharedTokenStore, TokenStore } from './tokens'

// Deduped across ApiClient instances so React Strict Mode (double mount) or
// concurrent authed requests don't rotate the same refresh token twice.
let refreshFlight: Promise<boolean> | null = null
let restoreFlight: Promise<User | null> | null = null

/** Test-only: reset in-flight auth promises between Vitest cases. */
export function resetAuthFlightsForTests(): void {
  refreshFlight = null
  restoreFlight = null
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ApiClientOptions {
  baseUrl: string
  tokens?: TokenStore
  fetchImpl?: FetchLike
}

// Talks to the Go backend. Access token rides on Authorization; on a 401 the
// client transparently rotates via the refresh token and retries once. All
// network I/O goes through an injectable fetch so it's unit-testable.
export class ApiClient {
  readonly baseUrl: string
  readonly tokens: TokenStore
  private readonly fetchImpl: FetchLike

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.tokens = opts.tokens ?? sharedTokenStore()
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  get isAuthenticated(): boolean {
    return this.tokens.hasSession
  }

  /** Validate stored tokens with /auth/me; refresh once when access expired. */
  async restoreSession(): Promise<User | null> {
    if (!this.tokens.hasSession) return null
    if (!restoreFlight) {
      restoreFlight = this.doRestoreSession().finally(() => {
        restoreFlight = null
      })
    }
    return restoreFlight
  }

  // ---- auth ----
  async register(email: string, password: string): Promise<TokenPair> {
    return this.authenticate('/auth/register', email, password)
  }

  async login(email: string, password: string): Promise<TokenPair> {
    return this.authenticate('/auth/login', email, password)
  }

  async me(): Promise<User> {
    const res = await this.authedFetch('/auth/me', { method: 'GET' })
    return this.json<User>(res)
  }

  async logout(): Promise<void> {
    const refreshToken = this.tokens.refresh
    this.tokens.clear()
    if (!refreshToken) return
    try {
      await this.rawFetch('/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      })
    } catch {
      /* best-effort; tokens are already cleared locally */
    }
  }

  // ---- documents ----
  async listDocuments(): Promise<DocumentMeta[]> {
    const res = await this.authedFetch('/documents', { method: 'GET' })
    return this.json<DocumentMeta[]>(res)
  }

  async createDocument(title = 'Untitled'): Promise<DocumentMeta> {
    const res = await this.authedFetch('/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title })
    })
    return this.json<DocumentMeta>(res)
  }

  async patchDocument(id: string, title: string): Promise<void> {
    await this.authedFetch(`/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title })
    })
  }

  async deleteDocument(id: string): Promise<void> {
    await this.authedFetch(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  // ---- internals ----
  private async authenticate(path: string, email: string, password: string): Promise<TokenPair> {
    const res = await this.rawFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const pair = await this.json<TokenPair>(res)
    this.tokens.save(pair)
    this.tokens.saveUser(pair.user)
    return pair
  }

  private rawFetch(path: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(this.baseUrl + path, init)
  }

  // authedFetch attaches the bearer token; on 401 it refreshes once and retries.
  private async authedFetch(path: string, init: RequestInit, retry = true): Promise<Response> {
    if (!this.tokens.access && this.tokens.refresh && retry) {
      if (!(await this.refreshTokens())) {
        throw new ApiError(401, 'session expired')
      }
      return this.authedFetch(path, init, false)
    }
    const res = await this.rawFetch(path, withAuth(init, this.tokens.access))
    if (res.status !== 401 || !retry) {
      if (!res.ok) throw await this.error(res)
      return res
    }
    if (!(await this.refreshTokens())) {
      throw new ApiError(401, 'session expired')
    }
    return this.authedFetch(path, init, false)
  }

  private async refreshTokens(): Promise<boolean> {
    const refreshToken = this.tokens.refresh
    if (!refreshToken) return false
    if (!refreshFlight) {
      refreshFlight = this.doRefreshTokens(refreshToken).finally(() => {
        refreshFlight = null
      })
    }
    return refreshFlight
  }

  private async doRefreshTokens(refreshToken: string): Promise<boolean> {
    const res = await this.rawFetch('/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    })
    if (!res.ok) {
      // Only wipe the session on auth rejection — a transient 5xx should not
      // force a re-login on the next page load.
      if (res.status === 401 || res.status === 403) this.tokens.clear()
      return false
    }
    const pair = (await res.json()) as TokenPair
    this.tokens.save(pair)
    if (pair.user) this.tokens.saveUser(pair.user)
    return true
  }

  private async doRestoreSession(): Promise<User | null> {
    try {
      const user = await this.me()
      this.tokens.saveUser(user)
      return user
    } catch {
      if (!this.tokens.hasSession) this.tokens.clear()
      return null
    }
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) throw await this.error(res)
    return (await res.json()) as T
  }

  private async error(res: Response): Promise<ApiError> {
    let msg = `request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) msg = body.error
    } catch {
      /* non-JSON error body */
    }
    return new ApiError(res.status, msg)
  }
}

function withAuth(init: RequestInit, token: string | null): RequestInit {
  if (!token) return init
  return { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } }
}
