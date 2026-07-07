import type { TokenPair } from './types'

// Minimal storage seam so the token store is testable without a browser.
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const ACCESS_KEY = 'tp.auth.access'
const REFRESH_KEY = 'tp.auth.refresh'

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

  save(pair: Pick<TokenPair, 'accessToken' | 'refreshToken'>): void {
    this.storage.setItem(ACCESS_KEY, pair.accessToken)
    this.storage.setItem(REFRESH_KEY, pair.refreshToken)
  }

  clear(): void {
    this.storage.removeItem(ACCESS_KEY)
    this.storage.removeItem(REFRESH_KEY)
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
