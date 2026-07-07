import { describe, it, expect } from 'vitest'
import { streamOpenModel } from './stream'
import { TEST_PROVIDER, sseResponse, mockFetchSequence } from './__mocks__/mock-provider'

describe('streamOpenModel', () => {
  it('emits completed lines and posts to the provider /chat/completions with auth', async () => {
    const lines: string[] = []
    const mock = mockFetchSequence([sseResponse(['- first ', 'bullet\n', '- second\n'])])
    await streamOpenModel(TEST_PROVIDER, {
      system: 'sys',
      userText: 'user',
      onText: (t) => lines.push(t),
      fetchImpl: mock.fetch
    })
    expect(lines.join('')).toBe('- first bullet\n- second\n')
    expect(mock.calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect((mock.calls[0].init?.headers as any).Authorization).toBe('Bearer test-key')
    expect(mock.calls[0].body.stream).toBe(true)
  })

  it('captures a trailing SEARCH line instead of showing it', async () => {
    const lines: string[] = []
    const mock = mockFetchSequence([sseResponse(['- Notion blocks\n', 'SEARCH: Notion block model\n'])])
    const intent = await streamOpenModel(TEST_PROVIDER, {
      system: 's',
      userText: 'u',
      onText: (t) => lines.push(t),
      fetchImpl: mock.fetch
    })
    expect(intent).toEqual({ query: 'Notion block model', image: false })
    expect(lines.join('')).toBe('- Notion blocks\n')
  })

  it('captures SEARCH IMAGE intent', async () => {
    const mock = mockFetchSequence([sseResponse(['- x\n', 'SEARCH IMAGE: op-1 synth\n'])])
    const intent = await streamOpenModel(TEST_PROVIDER, {
      system: 's',
      userText: 'u',
      onText: () => {},
      fetchImpl: mock.fetch
    })
    expect(intent).toEqual({ query: 'op-1 synth', image: true })
  })

  it('strips <think> blocks from the visible text', async () => {
    const lines: string[] = []
    const mock = mockFetchSequence([sseResponse(['<think>plan</think>', '- real bullet\n'])])
    await streamOpenModel(TEST_PROVIDER, {
      system: 's',
      userText: 'u',
      onText: (t) => lines.push(t),
      fetchImpl: mock.fetch
    })
    expect(lines.join('')).toBe('- real bullet\n')
  })

  it('throws on a non-ok response', async () => {
    const mock = mockFetchSequence([new Response('nope', { status: 429 })])
    await expect(
      streamOpenModel(TEST_PROVIDER, { system: 's', userText: 'u', onText: () => {}, fetchImpl: mock.fetch })
    ).rejects.toThrow(/LLM 429/)
  })

  it('omits Authorization for a keyless provider', async () => {
    const mock = mockFetchSequence([sseResponse(['- x\n'])])
    await streamOpenModel(
      { ...TEST_PROVIDER, apiKey: '' },
      { system: 's', userText: 'u', onText: () => {}, fetchImpl: mock.fetch }
    )
    expect((mock.calls[0].init?.headers as any).Authorization).toBeUndefined()
  })
})
