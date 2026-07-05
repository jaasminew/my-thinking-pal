import { getDispatcher } from './proxy'
import type { UrlCard } from '../services/llm/cocreate-types'

// Tavily is the default web-search backend for the `open` provider: it's built
// for LLM use, returns clean snippets, and has a generous free tier.
// https://tavily.com
//
// Two other picks if you outgrow it (swap the fetch below):
//   Exa   — neural/semantic "find inspiration like this" (api.exa.ai)
//   Brave — cheap independent index (api.search.brave.com)
//
// NOTE: no include_images here. Tavily's images are query-level, loosely paired
// to results by position — a mismatched thumbnail is worse than none. Card
// thumbnails and inline bullet images both come from fetchOgImage instead,
// which provably belongs to the page.
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
      search_depth: 'basic'
    }),
    dispatcher: getDispatcher()
  } as any)

  if (!r.ok) {
    throw new Error(`Tavily ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }
  const data: any = await r.json()
  const results: any[] = Array.isArray(data?.results) ? data.results : []

  return results.slice(0, max).map((res) => ({
    title: res.title || res.url,
    url: res.url,
    snippet: typeof res.content === 'string' ? res.content.slice(0, 180) : undefined
  }))
}

// A page's OWN representative image — og:image / twitter:image, the same one
// link unfurls (iMessage, Slack) use. One cheap GET of the page's HTML, no
// image-search API call, and unlike query-level image search the result
// provably belongs to the page. Returns undefined on any miss (blocked bot,
// no meta tag, bad URL) — callers degrade gracefully to words/card-only.
export async function fetchOgImage(pageUrl: string): Promise<string | undefined> {
  try {
    const r = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ThinkingPal/0.1; +local prototype)',
        Accept: 'text/html'
      },
      signal: AbortSignal.timeout(4000),
      redirect: 'follow',
      dispatcher: getDispatcher()
    } as any)
    if (!r.ok) return undefined
    const html = (await r.text()).slice(0, 300_000) // meta tags live in <head>
    for (const name of ['og:image', 'twitter:image', 'og:image:url']) {
      // Both attribute orders occur in the wild: property-then-content and back.
      const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*?content=["']([^"']+)["']`, 'i')
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["']${name}["']`, 'i')
      const m = html.match(re1) || html.match(re2)
      if (m) {
        const src = m[1].replace(/&amp;/g, '&').trim()
        try {
          return new URL(src, pageUrl).href // resolve protocol-relative / relative srcs
        } catch {
          return undefined
        }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
