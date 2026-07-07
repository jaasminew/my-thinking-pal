import { describe, it, expect } from 'vitest'
import { resolveProvider, isProviderUsable, PROVIDER_PRESETS } from './providers'

describe('resolveProvider', () => {
  it('fills baseUrl/model from a known preset and applies the user key', () => {
    const p = resolveProvider('groq', { apiKey: 'k' })
    expect(p.baseUrl).toBe(PROVIDER_PRESETS.groq.baseUrl)
    expect(p.model).toBe(PROVIDER_PRESETS.groq.defaultModel)
    expect(p.apiKey).toBe('k')
    expect(p.kind).toBe('openai-compatible')
  })

  it('lets overrides win over preset defaults', () => {
    const p = resolveProvider('groq', { model: 'custom-model' })
    expect(p.model).toBe('custom-model')
  })

  it('treats an unknown id with a baseUrl as a custom endpoint', () => {
    const p = resolveProvider('my-gw', { baseUrl: 'https://gw.local/v1', model: 'm' })
    expect(p.id).toBe('my-gw')
    expect(p.baseUrl).toBe('https://gw.local/v1')
  })

  it('throws for an unknown id without a baseUrl', () => {
    expect(() => resolveProvider('nope')).toThrow(/Unknown provider/)
  })
})

describe('isProviderUsable', () => {
  it('is true for keyless ollama even without a key', () => {
    expect(isProviderUsable(resolveProvider('ollama'))).toBe(true)
  })

  it('requires a key for hosted providers', () => {
    expect(isProviderUsable(resolveProvider('groq'))).toBe(false)
    expect(isProviderUsable(resolveProvider('groq', { apiKey: 'k' }))).toBe(true)
  })
})
