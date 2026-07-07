import { describe, it, expect } from 'vitest'
import { devSonioxKey } from './soniox-key'

describe('devSonioxKey', () => {
  it('reads key + model from the injected dev keys', () => {
    expect(devSonioxKey({ soniox: { key: 'sk-1', model: 'stt-rt-v5' } })).toEqual({
      key: 'sk-1',
      model: 'stt-rt-v5'
    })
  })

  it('defaults the model when the inject omits it', () => {
    expect(devSonioxKey({ soniox: { key: 'sk-1' } }).model).toBe('stt-rt-v5')
  })

  it('degrades to an empty key when there are no dev keys (static prod build)', () => {
    expect(devSonioxKey(null)).toEqual({ key: '', model: 'stt-rt-v5' })
  })

  it('degrades to an empty key when the soniox entry is absent', () => {
    expect(devSonioxKey({ groq: { key: 'g' } }).key).toBe('')
  })
})
