import type { TokenPair, User } from './types'

// Minimal storage seam so the token store is testable without a browser.
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const ACCESS_KEY = 'tp.auth.access'
const REFRESH_KEY = 'tp.auth.refresh'
const USER_KEY = 'tp.auth.user'

let sharedStore: TokenStore | null = null

/** Browser singleton so every ApiClient reads/writes the same persisted session. */
export function sharedTokenStore(): TokenStore {
  if (!sharedStore) sharedStore = new TokenStore()
  return sharedStore
}

export class TokenStore {
  private storage: KeyValueStorage

  constructor(storage?: KeyValueStorage) {
    this.storage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : memoryStorage())
  }

  get access(): string | null {
    return this.storage.getItem(ACCESS_KEY)
  }

  get refresh(): string | null {
    return this.storage.getItem(REFRESH_KEY)
  }

  /** True when either token is present (refresh alone can restore a session). */
  get hasSession(): boolean {
    return !!(this.access || this.refresh)
  }

  save(pair: Pick<TokenPair, 'accessToken' | 'refreshToken'>): void {
    this.storage.setItem(ACCESS_KEY, pair.accessToken)
    this.storage.setItem(REFRESH_KEY, pair.refreshToken)
  }

  saveUser(user: User): void {
    this.storage.setItem(USER_KEY, JSON.stringify(user))
  }

  loadUser(): User | null {
    try {
      const raw = this.storage.getItem(USER_KEY)
      return raw ? (JSON.parse(raw) as User) : null
    } catch {
      return null
    }
  }

  clear(): void {
    this.storage.removeItem(ACCESS_KEY)
    this.storage.removeItem(REFRESH_KEY)
    this.storage.removeItem(USER_KEY)
  }
}

export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k)
  }
}
