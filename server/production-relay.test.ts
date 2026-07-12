import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createRelayHandler } from './production-relay'

let server: Server | undefined

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve, reject) => {
    server!.close((error) => (error ? reject(error) : resolve()))
  })
  server = undefined
})

async function start(options: { rateLimitPerMinute?: number } = {}) {
  const search = vi.fn(async (query: string) => [{ title: query, url: 'https://example.com' }])
  const urlMeta = vi.fn(async () => ({ description: 'Example' }))
  server = createServer(createRelayHandler({ search, urlMeta }, options))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  return { baseUrl: `http://127.0.0.1:${address.port}`, search, urlMeta }
}

describe('production relay', () => {
  it('reports health without consuming the public rate limit', async () => {
    const { baseUrl } = await start({ rateLimitPerMinute: 1 })
    expect(await (await fetch(`${baseUrl}/healthz`)).json()).toEqual({ ok: true })
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200)
  })

  it('relays bounded search requests', async () => {
    const { baseUrl, search } = await start()
    const response = await fetch(`${baseUrl}/api/search?q=thinking&n=99`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      results: [{ title: 'thinking', url: 'https://example.com' }]
    })
    expect(search).toHaveBeenCalledWith('thinking', 5)
  })

  it('rejects invalid methods and oversized inputs', async () => {
    const { baseUrl } = await start()
    expect((await fetch(`${baseUrl}/api/search`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${baseUrl}/api/search?q=${'x'.repeat(501)}`)).status).toBe(400)
    expect((await fetch(`${baseUrl}/api/url-meta`)).status).toBe(400)
  })

  it('limits requests by forwarded client address', async () => {
    const { baseUrl } = await start({ rateLimitPerMinute: 1 })
    const headers = { 'x-forwarded-for': '203.0.113.8' }
    expect((await fetch(`${baseUrl}/api/search?q=one`, { headers })).status).toBe(200)
    const limited = await fetch(`${baseUrl}/api/search?q=two`, { headers })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
  })

  it('degrades search provider errors to empty results', async () => {
    const failingSearch = vi.fn(async () => {
      throw new Error('provider unavailable')
    })
    server = createServer(createRelayHandler({
      search: failingSearch,
      urlMeta: vi.fn(async () => ({}))
    }))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')

    const response = await fetch(`http://127.0.0.1:${address.port}/api/search?q=test`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ results: [], error: 'search_unavailable' })
  })
})
