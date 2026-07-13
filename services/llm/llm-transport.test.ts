import { afterEach, describe, expect, it } from 'vitest'
import {
  configureLlmTransport,
  hostedLlmAvailable,
  hostedProviderFor,
  HOSTED_LISTENER_MODEL,
  HOSTED_THINKER_MODEL,
  llmTransportMode,
  ROLE_HEADER
} from './llm-transport'

afterEach(() => {
  configureLlmTransport({ mode: 'client' })
})

describe('llm-transport', () => {
  it('defaults to client mode', () => {
    expect(llmTransportMode()).toBe('client')
    expect(hostedLlmAvailable()).toBe(false)
    expect(hostedProviderFor('listener')).toBeNull()
  })

  it('builds hosted providers with JWT and role header when apiBase is set', () => {
    configureLlmTransport({
      mode: 'hosted',
      apiBase: 'https://api.test',
      getToken: () => 'access-token'
    })
    expect(hostedLlmAvailable()).toBe(true)

    const listener = hostedProviderFor('listener')
    expect(listener).toMatchObject({
      id: 'hosted-deepseek',
      label: 'Hosted DeepSeek Flash',
      baseUrl: 'https://api.test/llm',
      apiKey: 'access-token',
      model: HOSTED_LISTENER_MODEL,
      kind: 'openai-compatible',
      requestHeaders: { [ROLE_HEADER]: 'listener' }
    })

    const thinker = hostedProviderFor('thinker')
    expect(thinker).toMatchObject({
      id: 'hosted-deepseek',
      label: 'Hosted DeepSeek Pro',
      model: HOSTED_THINKER_MODEL,
      requestHeaders: { [ROLE_HEADER]: 'thinker' }
    })
  })

  it('returns null without a token', () => {
    configureLlmTransport({
      mode: 'hosted',
      apiBase: 'https://api.test',
      getToken: () => null
    })
    expect(hostedProviderFor('thinker')).toBeNull()
  })
})
