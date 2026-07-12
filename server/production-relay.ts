import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { tavilySearch } from './search'
import { fetchUrlMeta } from './url-meta'

type RelayDependencies = {
  search: typeof tavilySearch
  urlMeta: typeof fetchUrlMeta
  now?: () => number
}

type RelayOptions = {
  rateLimitPerMinute?: number
  maxConcurrency?: number
}

type RateEntry = { count: number; resetAt: number }

export function createRelayHandler(
  dependencies: RelayDependencies = { search: tavilySearch, urlMeta: fetchUrlMeta },
  options: RelayOptions = {}
): RequestListener {
  const rateLimit = options.rateLimitPerMinute ?? envInt('RATE_LIMIT_PER_MINUTE', 60)
  const maxConcurrency = options.maxConcurrency ?? envInt('MAX_CONCURRENCY', 20)
  const now = dependencies.now ?? Date.now
  const clients = new Map<string, RateEntry>()
  let active = 0

  return async (request, response) => {
    const requestId = randomUUID()
    const startedAt = now()
    setCommonHeaders(response, requestId)

    let url: URL
    try {
      url = new URL(request.url || '/', 'http://relay.local')
    } catch {
      return json(response, 400, { error: 'invalid_request' })
    }

    if (url.pathname === '/healthz') {
      return json(response, 200, { ok: true })
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET')
      return json(response, 405, { error: 'method_not_allowed' })
    }
    if (url.pathname !== '/api/search' && url.pathname !== '/api/url-meta') {
      return json(response, 404, { error: 'not_found' })
    }

    const client = clientAddress(request)
    if (!allowRequest(clients, client, now(), rateLimit)) {
      response.setHeader('Retry-After', '60')
      return json(response, 429, { error: 'rate_limited' })
    }
    if (active >= maxConcurrency) {
      response.setHeader('Retry-After', '1')
      return json(response, 503, { error: 'busy' })
    }

    active += 1
    let status = 200
    try {
      if (url.pathname === '/api/search') {
        const query = (url.searchParams.get('q') || '').trim()
        const count = Math.max(1, Math.min(5, Number.parseInt(url.searchParams.get('n') || '1', 10) || 1))
        if (!query || query.length > 500) {
          status = 400
          return json(response, status, { results: [], error: 'invalid_query' })
        }
        try {
          return json(response, 200, { results: await dependencies.search(query, count) })
        } catch (error) {
          log('warn', requestId, request, client, 200, startedAt, error)
          return json(response, 200, { results: [], error: 'search_unavailable' })
        }
      }

      const target = url.searchParams.get('url') || ''
      if (!target || target.length > 2048) {
        status = 400
        return json(response, status, { error: 'invalid_url' })
      }
      return json(response, 200, await dependencies.urlMeta(target))
    } catch (error) {
      status = 500
      log('error', requestId, request, client, status, startedAt, error)
      return json(response, status, { error: 'internal_error' })
    } finally {
      active -= 1
      log('info', requestId, request, client, response.statusCode || status, startedAt)
    }
  }
}

export function startRelay() {
  const host = process.env.HOST || '127.0.0.1'
  const port = envInt('PORT', 3001)
  const server = createServer(createRelayHandler())
  server.requestTimeout = 10_000
  server.headersTimeout = 12_000
  server.keepAliveTimeout = 5_000
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
  server.listen(port, host, () => {
    console.log(JSON.stringify({ level: 'info', message: 'relay_started', host, port }))
  })

  const shutdown = () => {
    server.close((error) => {
      if (error) {
        console.error(JSON.stringify({ level: 'error', message: 'relay_shutdown_failed', error: error.message }))
        process.exitCode = 1
      }
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  return server
}

function allowRequest(
  clients: Map<string, RateEntry>,
  client: string,
  timestamp: number,
  limit: number
): boolean {
  if (clients.size > 10_000) {
    for (const [key, entry] of clients) if (entry.resetAt <= timestamp) clients.delete(key)
  }
  const entry = clients.get(client)
  if (!entry || entry.resetAt <= timestamp) {
    clients.set(client, { count: 1, resetAt: timestamp + 60_000 })
    return true
  }
  entry.count += 1
  return entry.count <= limit
}

function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return value?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown'
}

function setCommonHeaders(response: ServerResponse, requestId: string) {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Request-Id', requestId)
}

function json(response: ServerResponse, code: number, body: unknown) {
  response.statusCode = code
  response.end(JSON.stringify(body))
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function log(
  level: 'info' | 'warn' | 'error',
  requestId: string,
  request: IncomingMessage,
  client: string,
  status: number,
  startedAt: number,
  error?: unknown
) {
  const payload: Record<string, unknown> = {
    level,
    requestId,
    method: request.method,
    path: new URL(request.url || '/', 'http://relay.local').pathname,
    client,
    status,
    durationMs: Date.now() - startedAt
  }
  if (error) payload.error = error instanceof Error ? error.message : String(error)
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](JSON.stringify(payload))
}

