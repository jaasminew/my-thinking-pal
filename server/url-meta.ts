import { lookup as dnsLookupCallback } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent } from 'undici'

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

type LookupResult = { address: string; family: number }
type LookupFn = (hostname: string) => Promise<LookupResult[]>

const safeDirectDispatcher = new Agent({
  connect: {
    lookup: ((hostname: string, options: unknown, callback: (...args: any[]) => void) => {
      dnsLookupCallback(hostname, { ...(options as object), all: true }, (error, addresses) => {
        if (error) return callback(error)
        const results = addresses as LookupResult[]
        if (!results.length || results.some(({ address }) => !isPublicIp(address))) {
          return callback(new Error('DNS resolved to a non-public address'))
        }
        if ((options as { all?: boolean }).all) return callback(null, results)
        return callback(null, results[0].address, results[0].family)
      })
    }) as any
  }
})

const defaultLookup: LookupFn = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  return results.map(({ address, family }) => ({ address, family }))
}

export function isPublicIp(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (mapped) return isPublicIp(mapped)

  const family = isIP(address)
  if (family === 4) {
    const octets = address.split('.').map(Number)
    const [a, b] = octets
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) {
      return false
    }
    // Documentation-only ranges must not be reachable from the relay either.
    if (
      (a === 192 && b === 0 && octets[2] === 2) ||
      (a === 198 && b === 51 && octets[2] === 100) ||
      (a === 203 && b === 0 && octets[2] === 113)
    ) {
      return false
    }
    return true
  }

  if (family === 6) {
    const normalized = address.toLowerCase()
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    )
  }

  return false
}

export async function validatePublicUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are allowed')
  if (url.username || url.password) throw new Error('URL credentials are not allowed')
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Non-standard ports are not allowed')

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Private hosts are not allowed')
  }

  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error('Private addresses are not allowed')
    return url
  }

  const addresses = await lookup(hostname)
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error('Host resolves to a non-public address')
  }
  return url
}

export async function fetchUrlMeta(
  rawUrl: string
): Promise<{ description?: string; image?: string }> {
  try {
    let url = await validatePublicUrl(rawUrl)
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; ThinkingPal/1.0; +https://mythinkingpal.xyz)',
          Accept: 'text/html'
        },
        // URL metadata always connects directly through the guarded resolver.
        // A generic outbound proxy would resolve the target itself and reopen
        // the DNS-rebinding/SSRF gap this relay is designed to close.
        dispatcher: safeDirectDispatcher
      } as any)

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location || redirects === 3) return {}
        await response.body?.cancel()
        url = await validatePublicUrl(new URL(location, url).href)
        continue
      }

      if (!response.ok || !(response.headers.get('content-type') || '').includes('html')) return {}
      const html = await readTextLimit(response, 200_000)
      return parseUrlMeta(html, response.url || url.href)
    }
    return {}
  } catch {
    return {}
  }
}

export function parseUrlMeta(
  html: string,
  pageUrl: string
): { description?: string; image?: string } {
  const meta = (names: string[]): string | undefined => {
    for (const name of names) {
      const tag = html.match(
        new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i')
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
      image = new URL(image, pageUrl).href
    } catch {
      image = undefined
    }
  }
  return { description: description?.slice(0, 300), image }
}

async function readTextLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        break
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
