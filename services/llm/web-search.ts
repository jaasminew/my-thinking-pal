// Thin browser client for web search and og:image/metadata. When signed into
// the Go backend, ApiClient holds the auth path; local-only mode keeps the
// relative Vite `/api/*` relay. Soft-fails to empty so co-creation never hard-errors.

import type { FetchLike, UrlCard } from '../../packages/core/llm'

export type UrlMetaResult = { description?: string; image?: string }

/** How search/url-meta should be resolved for this session. */
export type WebSearchMode = 'local' | 'auth' | 'none'

export type WebSearchConfig = {
  mode: WebSearchMode
  /** Auth-gated Go proxy (required when mode === 'auth'). */
  search?: (query: string, n: number) => Promise<UrlCard[]>
  urlMeta?: (pageUrl: string) => Promise<UrlMetaResult>
}

let config: WebSearchConfig = { mode: 'local' }

/** App wires this when backend auth state changes. */
export function configureWebSearch(next: WebSearchConfig): void {
  config = next
}

export function webSearchMode(): WebSearchMode {
  return config.mode
}

export async function searchWeb(query: string, n = 1, fetchImpl: FetchLike = fetch): Promise<UrlCard[]> {
  if (config.mode === 'none') return []
  if (config.mode === 'auth' && config.search) {
    try {
      const results = await config.search(query, n)
      return Array.isArray(results) ? results : []
    } catch {
      return []
    }
  }
  try {
    const r = await fetchImpl(`/api/search?q=${encodeURIComponent(query)}&n=${n}`)
    if (!r.ok) return []
    const data = (await r.json()) as { results?: UrlCard[] }
    return Array.isArray(data?.results) ? data.results : []
  } catch {
    return []
  }
}

export async function fetchUrlMeta(pageUrl: string, fetchImpl: FetchLike = fetch): Promise<UrlMetaResult> {
  if (config.mode === 'none') return {}
  if (config.mode === 'auth' && config.urlMeta) {
    try {
      return (await config.urlMeta(pageUrl)) || {}
    } catch {
      return {}
    }
  }
  try {
    const r = await fetchImpl(`/api/url-meta?url=${encodeURIComponent(pageUrl)}`)
    if (!r.ok) return {}
    return ((await r.json()) as UrlMetaResult) || {}
  } catch {
    return {}
  }
}

// Resolve a page's own og:image (used for inline bullet images). Returns
// undefined when the page has none or the fetch fails.
export async function resolveOgImage(pageUrl: string, fetchImpl: FetchLike = fetch): Promise<string | undefined> {
  const m = await fetchUrlMeta(pageUrl, fetchImpl)
  return m?.image || undefined
}
