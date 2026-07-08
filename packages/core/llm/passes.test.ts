// Integration tests: drive the full client-direct passes end-to-end against a
// mock provider (no network, no keys). These are the flows the app relies on.

import { describe, it, expect } from 'vitest'
import { extractSignals, organize, sectionHeader, cocreateStream } from './passes'
import type { UrlCard } from './types'
import { TEST_PROVIDER, sseResponse, jsonResponse, mockFetchSequence } from './__mocks__/mock-provider'

describe('extractSignals (integration)', () => {
  it('returns parsed signals on a good JSON reply', async () => {
    const mock = mockFetchSequence([
      jsonResponse('{"signals":[{"type":"decision","text":"Ship Friday."}]}')
    ])
    const out = await extractSignals(TEST_PROVIDER, { systemPrompt: 'p', rawText: 'we ship friday' }, mock.fetch)
    expect(out.signals).toEqual([{ type: 'decision', text: 'Ship Friday.' }])
    expect(out.skipped).toBeUndefined()
    // The strict JSON contract is appended to the domain system prompt.
    expect(mock.calls[0].body.messages[0].content).toContain('Return ONLY a JSON object')
    expect(mock.calls[0].body.messages[0].content).toContain('never translate non-English speech into English')
  })

  it('reports skipped=true (retry) when the reply is unparseable', async () => {
    const mock = mockFetchSequence([jsonResponse('the model rambled')])
    const out = await extractSignals(TEST_PROVIDER, { systemPrompt: 'p', rawText: 'x' }, mock.fetch)
    expect(out.signals).toEqual([])
    expect(out.skipped).toBe(true)
  })

  it('returns an empty (non-skipped) list for a legitimate empty window', async () => {
    const mock = mockFetchSequence([jsonResponse('{"signals":[]}')])
    const out = await extractSignals(TEST_PROVIDER, { systemPrompt: 'p', rawText: 'small talk' }, mock.fetch)
    expect(out.signals).toEqual([])
    expect(out.skipped).toBeUndefined()
  })

  it('maps an HTTP failure to skipped=true (never throws)', async () => {
    const mock = mockFetchSequence([jsonResponse('boom', { status: 500 })])
    const out = await extractSignals(TEST_PROVIDER, { systemPrompt: 'p', rawText: 'x' }, mock.fetch)
    expect(out.skipped).toBe(true)
    expect(out.error).toMatch(/LLM 500/)
  })
})

describe('organize (integration)', () => {
  it('parses sections and never throws on failure', async () => {
    const good = mockFetchSequence([
      jsonResponse('{"sections":[{"header":"Storage","items":[{"src":[0,1]}]}]}')
    ])
    const out = await organize(TEST_PROVIDER, { lines: '0 [decision]: a\n1 [judgment]: b', closing: false }, good.fetch)
    expect(out.sections).toEqual([{ header: 'Storage', items: [{ src: [0, 1] }] }])

    const bad = mockFetchSequence([jsonResponse('err', { status: 503 })])
    const out2 = await organize(TEST_PROVIDER, { lines: 'x' }, bad.fetch)
    expect(out2.sections).toEqual([])
    expect(out2.error).toMatch(/LLM 503/)
  })

  it('selects the closing system prompt when closing=true', async () => {
    const mock = mockFetchSequence([jsonResponse('{"sections":[]}')])
    await organize(TEST_PROVIDER, { lines: 'x', closing: true }, mock.fetch)
    expect(mock.calls[0].body.messages[0].content).toContain('This is the FINAL pass')
  })
})

describe('sectionHeader (integration)', () => {
  it('returns a cleaned title', async () => {
    const mock = mockFetchSequence([jsonResponse('- "Storage design"')])
    const out = await sectionHeader(TEST_PROVIDER, 'notes about storage', mock.fetch)
    expect(out.header).toBe('Storage design')
  })
})

describe('cocreateStream (integration)', () => {
  it('streams bullets, captures diagnosis/anchor, and turns a cited link into a card', async () => {
    const text: string[] = []
    const urls: UrlCard[] = []
    let diagnosis = ''
    let anchor = -1
    const mock = mockFetchSequence([
      sseResponse([
        'DIAGNOSIS: needs a real case\n',
        'ANCHOR: 1\n',
        '- [Notion](https://notion.so) stores everything as blocks\n'
      ])
    ])
    const out = await cocreateStream(
      TEST_PROVIDER,
      { system: 'sys', userText: 'user' },
      {
        onText: (t) => text.push(t),
        onDiagnosis: (d) => (diagnosis = d),
        onAnchor: (a) => (anchor = a),
        onUrl: (u) => urls.push(u)
      },
      mock.fetch
    )
    expect(diagnosis).toBe('needs a real case')
    expect(anchor).toBe(1)
    expect(text.join('')).toContain('Notion stores everything as blocks')
    expect(text.join('')).not.toContain('https://')
    expect(urls).toEqual([{ title: 'Notion', url: 'https://notion.so' }])
    expect(out.passed).toBe(false)
    expect(out.contentLines).toBe(1)
  })

  it('reports passed and suppresses the search intent on PASS', async () => {
    const mock = mockFetchSequence([
      sseResponse(['DIAGNOSIS: fine\n', 'PASS\n', 'SEARCH: should be ignored\n'])
    ])
    const out = await cocreateStream(TEST_PROVIDER, { system: 's', userText: 'u' }, { onText: () => {} }, mock.fetch)
    expect(out.passed).toBe(true)
    expect(out.searchIntent).toBeUndefined()
  })

  it('surfaces the search intent when the model requested one and did not pass', async () => {
    const mock = mockFetchSequence([sseResponse(['- a real bullet\n', 'SEARCH: query here\n'])])
    const out = await cocreateStream(TEST_PROVIDER, { system: 's', userText: 'u' }, { onText: () => {} }, mock.fetch)
    expect(out.searchIntent).toEqual({ query: 'query here', image: false })
  })
})
