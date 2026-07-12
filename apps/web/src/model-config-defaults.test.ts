import { describe, expect, it } from 'vitest'
import { normalizeModelConfigs, normalizeModelSelections } from './App'

describe('model configuration defaults', () => {
  it('removes model placeholders persisted by older builds', () => {
    const configs = normalizeModelConfigs([
      {
        id: 'groq-gpt-oss-120b',
        label: 'Groq · GPT-OSS 120B',
        runtime: 'api',
        providerId: 'groq',
        model: 'openai/gpt-oss-120b'
      }
    ])

    expect(configs).toEqual([])
    expect(normalizeModelSelections({ listener: 'groq-gpt-oss-120b', thinker: 'groq-gpt-oss-120b' }, configs)).toEqual({
      listener: '',
      thinker: ''
    })
  })

  it('keeps models explicitly added by the user', () => {
    const configs = normalizeModelConfigs([
      {
        id: 'user-groq',
        label: 'My Groq model',
        runtime: 'api',
        providerId: 'groq',
        model: 'openai/gpt-oss-120b',
        apiKey: 'secret'
      }
    ])

    expect(configs).toHaveLength(1)
    expect(configs[0].id).toBe('user-groq')
  })
})
