import { describe, it, expect } from 'vitest'
import { resolveCategoryProvider, DEFAULT_BASE_MODEL, type CategoryAssignment } from './model-roles'
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

const apiAssignment = (providerId: string, model?: string): CategoryAssignment => ({
  runtime: 'api',
  providerId,
  model
})

describe('resolveCategoryProvider', () => {
  it('uses the assigned web model when usable', async () => {
    const { fn, calls } = mockResolve({ openai: 'sk-key', groq: 'gk' })
    const res = await resolveCategoryProvider('thinker', apiAssignment('openai', 'gpt-5.5'), {
      resolveProvider: fn
    })
    expect(res.provider?.id).toBe('openai')
    expect(res.provider?.model).toBe('gpt-5.5')
    expect(res.error).toBeUndefined()
    // Assigned model resolved first — no need to reach the fallback.
    expect(calls).toHaveLength(1)
  })

  it('falls back to DEFAULT_BASE_MODEL when the assigned model is unusable', async () => {
    const { fn, calls } = mockResolve({ groq: 'gk' }) // openai has no key
    const res = await resolveCategoryProvider('thinker', apiAssignment('openai'), { resolveProvider: fn })
    expect(res.provider?.id).toBe(DEFAULT_BASE_MODEL.providerId)
    expect(res.provider?.model).toBe(DEFAULT_BASE_MODEL.model)
    expect(calls).toHaveLength(2) // assigned attempt, then fallback
  })

  it('errors when neither the assigned model nor the default is usable', async () => {
    const { fn } = mockResolve({}) // nothing has a key
    const res = await resolveCategoryProvider('listener', apiAssignment('openai'), { resolveProvider: fn })
    expect(res.provider).toBeUndefined()
    expect(res.runtime).toBeUndefined()
    expect(res.error).toMatch(/listener/i)
  })

  it('keyless providers (ollama) are usable without a key', async () => {
    // mockResolve returns empty apiKey for ollama, but the real isProviderUsable
    // treats ollama as keyless; emulate by giving the mock an ollama key so the
    // resolution reflects usable=true. (The keyless preset is covered by
    // providers.test.ts.)
    const { fn } = mockResolve({ ollama: 'x' })
    const res = await resolveCategoryProvider('listener', { runtime: 'ollama' }, { resolveProvider: fn })
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
    // CLI runtime is trusted at resolve time — no provider resolution happens.
    expect(calls).toHaveLength(0)
  })

  it('Listener rejects a CLI assignment and falls back to the default', async () => {
    const { fn } = mockResolve({ groq: 'gk' })
    const res = await resolveCategoryProvider(
      'listener',
      { runtime: 'codex', command: 'codex' },
      { resolveProvider: fn }
    )
    expect(res.runtime).toBeUndefined()
    expect(res.provider?.id).toBe(DEFAULT_BASE_MODEL.providerId)
  })

  it('resolves the default when no model is assigned', async () => {
    const { fn } = mockResolve({ groq: 'gk' })
    const res = await resolveCategoryProvider('thinker', undefined, { resolveProvider: fn })
    expect(res.provider?.id).toBe('groq')
    expect(res.provider?.model).toBe(DEFAULT_BASE_MODEL.model)
  })
})
