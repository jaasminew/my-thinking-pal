// Backend base URL comes from build-time env. When empty the app runs in the
// original local-only mode (no login, no sync) — so nothing regresses when the
// Go backend isn't deployed.
export function apiBaseUrl(): string {
  const raw = (import.meta.env?.VITE_API_URL as string | undefined) ?? ''
  return raw.replace(/\/+$/, '')
}

export function apiEnabled(): boolean {
  return apiBaseUrl() !== ''
}

// Build a WebSocket URL for /sync or /stt: http(s)->ws(s), token in query
// (browsers can't set Authorization headers on WebSocket handshakes).
export function wsUrl(baseUrl: string, path: string, token: string): string {
  const base = baseUrl.replace(/^http/i, 'ws')
  const sep = path.includes('?') ? '&' : '?'
  return `${base}${path}${sep}token=${encodeURIComponent(token)}`
}
