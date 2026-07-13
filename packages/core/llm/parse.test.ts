import { describe, it, expect } from 'vitest'
import {
  parseSignals,
  parseOrganize,
  sanitizeCleanedTranscript,
  cleanSectionHeader,
  getReasoningParams,
  getJsonReasoningParams
} from './parse'

describe('parseSignals', () => {
  it('parses a well-formed signals object', () => {
    const raw = '{"signals":[{"type":"decision","text":"We ship Friday.","speaker":"S1"}]}'
    expect(parseSignals(raw)).toEqual([{ type: 'decision', text: 'We ship Friday.', speaker: 'S1' }])
  })

  it('tolerates code fences and surrounding prose', () => {
    const raw = 'Sure!\n```json\n{"signals":[{"type":"judgment","text":"X beats Y."}]}\n```'
    expect(parseSignals(raw)).toEqual([{ type: 'judgment', text: 'X beats Y.' }])
  })

  it('strips leaked <think> blocks before parsing', () => {
    const raw = '<think>hmm let me decide</think>{"signals":[]}'
    expect(parseSignals(raw)).toEqual([])
  })

  it('drops entries with an invalid type (question/hesitation are never signals)', () => {
    const raw = '{"signals":[{"type":"question","text":"really?"},{"type":"example","text":"like Notion"}]}'
    expect(parseSignals(raw)).toEqual([{ type: 'example', text: 'like Notion' }])
  })

  it('returns null when nothing parseable', () => {
    expect(parseSignals('the model rambled with no json')).toBeNull()
  })

  it('returns [] for a legitimate empty window', () => {
    expect(parseSignals('{"signals":[]}')).toEqual([])
  })
})

describe('parseOrganize', () => {
  it('parses sections with src indices and optional rewrites', () => {
    const raw = '{"sections":[{"header":"Storage model","items":[{"src":[0,1],"text":"merged"},{"src":[2]}]}]}'
    expect(parseOrganize(raw)).toEqual([
      { header: 'Storage model', items: [{ src: [0, 1], text: 'merged' }, { src: [2] }] }
    ])
  })

  it('drops items with empty src and sections with no valid items', () => {
    const raw = '{"sections":[{"header":"X","items":[{"src":[]}]},{"header":"Y","items":[{"src":[3]}]}]}'
    expect(parseOrganize(raw)).toEqual([{ header: 'Y', items: [{ src: [3] }] }])
  })

  it('returns [] on unparseable input', () => {
    expect(parseOrganize('no json here')).toEqual([])
  })
})

describe('sanitizeCleanedTranscript / cleanSectionHeader', () => {
  it('removes closed think blocks', () => {
    expect(sanitizeCleanedTranscript('<think>plan</think>Real title')).toBe('Real title')
  })

  it('returns empty when reasoning is unclosed', () => {
    expect(sanitizeCleanedTranscript('<think>never closed ...')).toBe('')
  })

  it('cleanSectionHeader strips bullets and quotes', () => {
    expect(cleanSectionHeader('- "Storage design"')).toBe('Storage design')
  })
})

describe('reasoning params', () => {
  it('hides gpt-oss reasoning (low for stream, medium for json)', () => {
    expect(getReasoningParams('openai/gpt-oss-20b')).toMatchObject({ reasoning_effort: 'low', reasoning_format: 'hidden' })
    expect(getJsonReasoningParams('openai/gpt-oss-20b')).toMatchObject({ reasoning_effort: 'medium', reasoning_format: 'hidden' })
  })

  it('is empty for a plain model', () => {
    expect(getReasoningParams('llama3.1-8b')).toEqual({})
  })

  it('omits unsupported reasoning extensions for native DeepSeek requests', () => {
    expect(getJsonReasoningParams('deepseek-v4-flash')).toEqual({})
  })
})
