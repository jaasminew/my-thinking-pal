import { getDispatcher } from './proxy'

// Best-effort page metadata for an inspiration card: the short "what this
// site is" blurb (og:description / meta description) and a thumbnail
// (og:image). CLI-provider search results arrive as bare title+url, so the
// card UI asks this for the rest. Any failure just returns {} — the card
// then renders without a description/image rather than erroring.

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))

export async function fetchUrlMeta(
  url: string
): Promise<{ description?: string; image?: string }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 6000)
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        // Some sites serve bots an empty shell; a browser UA gets the real head.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
        Accept: 'text/html'
      },
      dispatcher: getDispatcher()
    } as any)
    if (!r.ok || !(r.headers.get('content-type') || '').includes('html')) return {}
    // Meta tags live in <head>; 200 KB caps pathological pages.
    const html = (await r.text()).slice(0, 200_000)

    const meta = (names: string[]): string | undefined => {
      for (const n of names) {
        const tag = html.match(
          new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, 'i')
        )?.[0]
        const content = tag?.match(/content=["']([^"']*)["']/i)?.[1]?.trim()
        if (content) return decodeEntities(content)
      }
      return undefined
    }

    const description = meta(['og:description', 'twitter:description', 'description'])
    let image = meta(['og:image', 'og:image:url', 'twitter:image'])
    if (image) {
      try {
        image = new URL(image, r.url || url).href // resolve relative og:image
      } catch {
        image = undefined
      }
    }
    return { description: description?.slice(0, 300), image }
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}
