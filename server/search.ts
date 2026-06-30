import { getDispatcher } from './proxy'
import type { UrlCard } from '../services/llm/cocreate-types'

// Tavily is the default web-search backend for the `open` provider: it's built
// for LLM use, returns clean snippets + images (→ the inspiration-card thumbnails),
// and has a generous free tier. https://tavily.com
//
// Two other picks if you outgrow it (swap the fetch below):
//   Exa   — neural/semantic "find inspiration like this" (api.exa.ai)
//   Brave — cheap independent index (api.search.brave.com)
export async function tavilySearch(query: string, max = 3): Promise<UrlCard[]> {
  const key = process.env.TAVILY_API_KEY
  if (!key) throw new Error('TAVILY_API_KEY missing in .env')

  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: max,
      include_images: true,
      search_depth: 'basic'
    }),
    dispatcher: getDispatcher()
  } as any)

  if (!r.ok) {
    throw new Error(`Tavily ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }
  const data: any = await r.json()
  const images: string[] = Array.isArray(data?.images) ? data.images : []
  const results: any[] = Array.isArray(data?.results) ? data.results : []

  return results.slice(0, max).map((res, i) => ({
    title: res.title || res.url,
    url: res.url,
    snippet: typeof res.content === 'string' ? res.content.slice(0, 180) : undefined,
    image: typeof images[i] === 'string' ? images[i] : undefined
  }))
}
