import { afterEach, describe, it, expect } from 'vitest'
import { resolveCategoryProvider, DEFAULT_BASE_MODEL, type CategoryAssignment } from './model-roles'
import { configureLlmTransport } from './llm-transport'
import type { LlmProvider } from '../../packages/core/llm'

// A mock resolver: usable only when the requested provider has a key here.
function mockResolve(usableKeys: Record<string, string | undefined>) {
  const calls: { providerId?: string; model?: string }[] = []
  const fn = async (providerId?: string, model?: string): Promise<LlmProvider> => {
    calls.push({ providerId, model })
    return {
      id: providerId || 'groq',
      label: providerId || 'groq',
      baseUrl: 'https://example/v1',
      apiKey: usableKeys[providerId || 'groq'] ?? '',
      model: model || '',
      kind: 'openai-compatible'
    }
  }
  return { fn, calls }
}

const apiAssignment = (providerId: string, model?: string, apiKey?: string): CategoryAssignment => ({
  runtime: 'api',
  providerId,
  model,
  apiKey
})

afterEach(() => {
  configureLlmTransport({ mode: 'client' })
})

describe('resolveCategoryProvider', () => {
  it('uses the assigned web model when BYOK key is present', async () => {
    const { fn, calls } = mockResolve({ openai: 'sk-key', groq: 'gk' })
    const res = await resolveCategoryProvider('thinker', apiAssignment('openai', 'gpt-5.5', 'sk-key'), {
      resolveProvider: fn
    })
    expect(res.provider?.id).toBe('openai')
    expect(res.provider?.model).toBe('gpt-5.5')
    expect(res.error).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('prefers hosted DeepSeek over an assigned model without a key', async () => {
    const hosted: LlmProvider = {
      id: 'hosted-deepseek',
      label: 'Hosted',
      baseUrl: 'https://api.test/llm',
      apiKey: 'jwt',
      model: 'deepseek-v4-pro',
      kind: 'openai-compatible'
    }
    const { fn, calls } = mockResolve({ groq: 'gk' })
    const res = await resolveCategoryProvider('thinker', apiAssignment('openai'), {
      resolveProvider: fn,
      hostedProvider: () => hosted
    })
    expect(res.provider?.id).toBe('hosted-deepseek')
    expect(calls).toHaveLength(0)
  })

  it('falls back to DEFAULT_BASE_MODEL when assigned BYOK is unusable and hosted is off', async () => {
    const { fn, calls } = mockResolve({ groq: 'gk' }) // openai has no key
    const res = await resolveCategoryProvider('thinker', apiAssignment('openai', undefined, 'bad'), {
      resolveProvider: fn,
      hostedProvider: () => null
    })
    expect(res.provider?.id).toBe(DEFAULT_BASE_MODEL.providerId)
    expect(res.provider?.model).toBe(DEFAULT_BASE_MODEL.model)
    expect(calls).toHaveLength(2)
  })

  it('errors when neither hosted nor default is usable', async () => {
    const { fn } = mockResolve({})
    const res = await resolveCategoryProvider('listener', apiAssignment('openai'), {
      resolveProvider: fn,
      hostedProvider: () => null
    })
    expect(res.provider).toBeUndefined()
    expect(res.runtime).toBeUndefined()
    expect(res.error).toMatch(/listener/i)
  })

  it('keyless providers (ollama) are usable without a key', async () => {
    const { fn } = mockResolve({ ollama: 'x' })
    const res = await resolveCategoryProvider('listener', { runtime: 'ollama' }, {
      resolveProvider: fn,
      hostedProvider: () => null
    })
    expect(res.provider?.id).toBe('ollama')
  })

  it('resolves a Thinker CLI runtime to the local-runtime path', async () => {
    const { fn, calls } = mockResolve({ groq: 'gk' })
    const res = await resolveCategoryProvider(
      'thinker',
      { runtime: 'claude-code', command: 'claude', model: 'opus' },
      { resolveProvider: fn }
    )
    expect(res.runtime).toBe('claude-code')
    expect(res.command).toBe('claude')
    expect(res.model).toBe('opus')
    expect(res.provider).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('Listener rejects a CLI assignment and falls back to hosted or default', async () => {
    const { fn } = mockResolve({ groq: 'gk' })
    const res = await resolveCategoryProvider(
      'listener',
      { runtime: 'codex', command: 'codex' },
      { resolveProvider: fn, hostedProvider: () => null }
    )
    expect(res.runtime).toBeUndefined()
    expect(res.provider?.id).toBe(DEFAULT_BASE_MODEL.providerId)
  })

  it('uses hosted when no model is assigned and hosted is available', async () => {
    const hosted: LlmProvider = {
      id: 'hosted-deepseek',
      label: 'Hosted Flash',
      baseUrl: 'https://api.test/llm',
      apiKey: 'jwt',
      model: 'deepseek-v4-flash',
      kind: 'openai-compatible'
    }
    const { fn } = mockResolve({ groq: 'gk' })
    const res = await resolveCategoryProvider('listener', undefined, {
      resolveProvider: fn,
      hostedProvider: () => hosted
    })
    expect(res.provider?.id).toBe('hosted-deepseek')
    expect(res.provider?.model).toBe('deepseek-v4-flash')
  })
})
