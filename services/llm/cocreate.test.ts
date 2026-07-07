import { describe, it, expect } from 'vitest'
import { requestCocreate } from './cocreate'
import type { UrlCard } from './cocreate-types'
import { TEST_PROVIDER, sseResponse, rawJsonResponse, mockFetchRouter } from '../../packages/core/llm/__mocks__/mock-provider'

// Client-direct cocreate: the LLM stream comes from the provider mock; web
// search + og:image come from the minimal backend relays (also mocked). The
// requestCocreate contract is unchanged from the old /api/cocreate version.

describe('requestCocreate (client-direct)', () => {
  it('streams bullets, captures diagnosis/anchor, and searches when the model asks', async () => {
    const text: string[] = []
    const urls: UrlCard[] = []
    let diagnosis = ''
    let anchor = -1
    const mock = mockFetchRouter([
      {
        match: (u) => u.includes('/chat/completions'),
        respond: () =>
          sseResponse([
            'DIAGNOSIS: needs a real case\n',
            'ANCHOR: 1\n',
            '- Modular blocks like Notion\n',
            'SEARCH: Notion block data model\n'
          ])
      },
      {
        match: (u) => u.includes('/api/search'),
        respond: () => rawJsonResponse({ results: [{ title: 'Notion', url: 'https://notion.so' }] })
      }
    ])

    const res = await requestCocreate(
      { seedText: 'modular storage', provider: 'open', openSub: 'groq', webSearch: true },
      {
        onText: (t) => text.push(t),
        onDiagnosis: (d) => (diagnosis = d),
        onAnchor: (a) => (anchor = a),
        onUrls: (u) => urls.push(...u)
      },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )

    expect(diagnosis).toBe('needs a real case')
    expect(anchor).toBe(1)
    expect(text.join('')).toContain('Modular blocks like Notion')
    expect(urls).toEqual([{ title: 'Notion', url: 'https://notion.so' }])
    expect(res.urls).toEqual([{ title: 'Notion', url: 'https://notion.so' }])
    // The search query the model named actually drove the relay.
    expect(mock.calls.some((c) => c.url.includes('Notion%20block%20data%20model'))).toBe(true)
  })

  it('does not search on PASS', async () => {
    const mock = mockFetchRouter([
      { match: (u) => u.includes('/chat/completions'), respond: () => sseResponse(['DIAGNOSIS: fine\n', 'PASS\n']) },
      { match: (u) => u.includes('/api/search'), respond: () => rawJsonResponse({ results: [{ title: 'x', url: 'https://x.com' }] }) }
    ])
    const res = await requestCocreate(
      { seedText: 'x', provider: 'open', openSub: 'groq', webSearch: true },
      { onText: () => {} },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    expect(res.urls).toEqual([])
    expect(mock.calls.some((c) => c.url.includes('/api/search'))).toBe(false)
  })

  it('resolves a SEARCH IMAGE intent to an inline image via url-meta', async () => {
    let image: any
    const mock = mockFetchRouter([
      {
        match: (u) => u.includes('/chat/completions'),
        respond: () => sseResponse(['- visual thing\n', 'SEARCH IMAGE: op-1 synth\n'])
      },
      { match: (u) => u.includes('/api/search'), respond: () => rawJsonResponse({ results: [{ title: 'OP-1', url: 'https://te.com/op1' }] }) },
      { match: (u) => u.includes('/api/url-meta'), respond: () => rawJsonResponse({ image: 'https://te.com/op1.png' }) }
    ])
    await requestCocreate(
      { seedText: 'x', provider: 'open', openSub: 'groq', webSearch: true },
      { onText: () => {}, onImage: (im) => (image = im) },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    expect(image).toMatchObject({ src: 'https://te.com/op1.png', sourceUrl: 'https://te.com/op1', title: 'OP-1' })
  })

  it('requires seedText or command', async () => {
    const res = await requestCocreate(
      { seedText: '', provider: 'open' } as any,
      { onText: () => {} },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mockFetchRouter([]).fetch }
    )
    expect(res.error).toMatch(/required/)
  })
})
