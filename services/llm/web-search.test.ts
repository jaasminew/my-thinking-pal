import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureWebSearch, fetchUrlMeta, searchWeb, webSearchMode } from './web-search'

afterEach(() => {
  configureWebSearch({ mode: 'local' })
})

describe('web-search relay modes', () => {
  it('local mode hits relative /api/search', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ title: 'a', url: 'https://a.com' }] }), { status: 200 })
    )
    configureWebSearch({ mode: 'local' })
    const results = await searchWeb('q', 2, fetchImpl as any)
    expect(fetchImpl).toHaveBeenCalledWith('/api/search?q=q&n=2')
    expect(results).toEqual([{ title: 'a', url: 'https://a.com' }])
  })

  it('auth mode uses injected search', async () => {
    const search = vi.fn(async () => [{ title: 'b', url: 'https://b.com' }])
    configureWebSearch({ mode: 'auth', search })
    expect(webSearchMode()).toBe('auth')
    expect(await searchWeb('hello', 3)).toEqual([{ title: 'b', url: 'https://b.com' }])
    expect(search).toHaveBeenCalledWith('hello', 3)
  })

  it('none mode returns empty without fetching', async () => {
    const fetchImpl = vi.fn()
    configureWebSearch({ mode: 'none' })
    expect(await searchWeb('q', 1, fetchImpl as any)).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('auth url-meta uses injected handler', async () => {
    configureWebSearch({
      mode: 'auth',
      urlMeta: async () => ({ description: 'd', image: 'https://i' })
    })
    expect(await fetchUrlMeta('https://x.com')).toEqual({ description: 'd', image: 'https://i' })
  })
})
