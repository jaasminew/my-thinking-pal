import { describe, it, expect } from 'vitest'
import { resolveSearchPath } from './observer-search'

describe('resolveSearchPath', () => {
  it('maps codex to cli-native', () => {
    expect(resolveSearchPath('codex', true)).toBe('cli-native')
    expect(resolveSearchPath('codex', false)).toBe('cli-native')
  })

  it('maps claude-code to cli-native', () => {
    expect(resolveSearchPath('claude-code', true)).toBe('cli-native')
    expect(resolveSearchPath('claude-code', false)).toBe('cli-native')
  })

  it('maps cursor to cli-native', () => {
    expect(resolveSearchPath('cursor', true)).toBe('cli-native')
    expect(resolveSearchPath('cursor', false)).toBe('cli-native')
  })

  it('maps web id + relay available to relay', () => {
    expect(resolveSearchPath('groq', true)).toBe('relay')
    expect(resolveSearchPath('openai', true)).toBe('relay')
  })

  it('maps web id + no relay to none', () => {
    expect(resolveSearchPath('groq', false)).toBe('none')
    expect(resolveSearchPath('openai', false)).toBe('none')
  })

  it('unknown id follows web-id rules', () => {
    expect(resolveSearchPath('unknown-provider', true)).toBe('relay')
    expect(resolveSearchPath('unknown-provider', false)).toBe('none')
  })
})
