import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LLM_SETTINGS,
  normalizeProviderId,
  resolveFromSettings,
  type LlmSettings
} from './llm-settings'

const settings: LlmSettings = {
  activeProviderId: 'groq',
  providers: { groq: { apiKey: 'k', model: 'openai/gpt-oss-20b' } }
}

describe('normalizeProviderId', () => {
  it('honors a real preset id', () => {
    expect(normalizeProviderId('cerebras', settings)).toBe('cerebras')
  })

  it('honors DeepSeek even before a base URL override is persisted', () => {
    expect(normalizeProviderId('deepseek', settings)).toBe('deepseek')
  })

  it('maps retired CLI / open aliases to the active provider', () => {
    expect(normalizeProviderId('codex', settings)).toBe('groq')
    expect(normalizeProviderId('claude-code', settings)).toBe('groq')
    expect(normalizeProviderId('open', settings)).toBe('groq')
    expect(normalizeProviderId(undefined, settings)).toBe('groq')
  })

  it('falls back to groq when the active provider is itself an alias', () => {
    expect(normalizeProviderId('codex', { activeProviderId: 'open', providers: {} })).toBe('groq')
  })

  it('honors a saved custom provider with a base URL', () => {
    expect(normalizeProviderId('deepseek', {
      activeProviderId: 'groq',
      providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1' } }
    })).toBe('deepseek')
  })
})

describe('resolveFromSettings', () => {
  it('produces a callable provider with the stored key + model', () => {
    const p = resolveFromSettings(settings)
    expect(p.id).toBe('groq')
    expect(p.apiKey).toBe('k')
    expect(p.model).toBe('openai/gpt-oss-20b')
  })

  it('applies a per-call model override', () => {
    const p = resolveFromSettings(settings, { model: 'llama-3.1-8b-instant' })
    expect(p.model).toBe('llama-3.1-8b-instant')
  })

  it('resolves a CLI provider id onto the active OpenAI-compatible provider', () => {
    const p = resolveFromSettings(settings, { providerId: 'codex' })
    expect(p.id).toBe('groq')
    expect(p.apiKey).toBe('k')
  })

  it('resolves a custom provider from stored base URL and key', () => {
    const p = resolveFromSettings({
      activeProviderId: 'groq',
      providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'dk', model: 'deepseek-chat' } }
    }, { providerId: 'deepseek' })
    expect(p.id).toBe('deepseek')
    expect(p.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(p.apiKey).toBe('dk')
    expect(p.model).toBe('deepseek-chat')
  })

  it('works from defaults with an empty key (unusable but resolvable)', () => {
    const p = resolveFromSettings(DEFAULT_LLM_SETTINGS)
    expect(p.id).toBe('groq')
    expect(p.apiKey).toBe('')
  })
})
