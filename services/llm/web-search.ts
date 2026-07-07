// Thin browser client for the two capabilities that stay server-side after the
// LLM moved client-direct: real web search (Tavily key + CN proxy) and og:image
// resolution (arbitrary-page scraping is blocked by CORS in the browser). Both
// degrade to "no result" on any failure so co-creation never hard-errors.

import type { FetchLike, UrlCard } from '../../packages/core/llm'

export async function searchWeb(query: string, n = 1, fetchImpl: FetchLike = fetch): Promise<UrlCard[]> {
  try {
    const r = await fetchImpl(`/api/search?q=${encodeURIComponent(query)}&n=${n}`)
    if (!r.ok) return []
    const data = (await r.json()) as { results?: UrlCard[] }
    return Array.isArray(data?.results) ? data.results : []
  } catch {
    return []
  }
}

// Resolve a page's own og:image (used for inline bullet images). Returns
// undefined when the page has none or the fetch fails.
export async function resolveOgImage(pageUrl: string, fetchImpl: FetchLike = fetch): Promise<string | undefined> {
  try {
    const r = await fetchImpl(`/api/url-meta?url=${encodeURIComponent(pageUrl)}`)
    if (!r.ok) return undefined
    const m = (await r.json()) as { image?: string }
    return m?.image || undefined
  } catch {
    return undefined
  }
}
