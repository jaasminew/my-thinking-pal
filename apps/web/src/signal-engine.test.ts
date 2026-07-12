import { describe, expect, it } from 'vitest'
import { SignalEngine } from './signal-engine'

const makeEngine = () =>
  new SignalEngine({
    provider: 'test',
    organizeProvider: 'test',
    systemPrompt: '',
    extractIntervalMs: 120_000,
    organizeIntervalMs: 300_000,
    minWords: 8,
    minCjkChars: 8
  })

describe('SignalEngine recording sessions', () => {
  it('keeps existing transcript content when capture state is reset', () => {
    const engine = makeEngine()
    const section = {
      id: 'section-1',
      header: 'Existing summary',
      lines: [{ id: 'line-1', text: 'An earlier highlight', ts: 1 }]
    }
    const tail = { id: 'line-2', text: 'An existing trailing highlight', ts: 2 }
    engine.frozenSections = [section]
    engine.tail = [tail]

    engine.resetCapture()

    expect(engine.frozenSections).toEqual([section])
    expect(engine.tail).toEqual([tail])
  })

  it('still erases transcript content on a full reset', () => {
    const engine = makeEngine()
    engine.frozenSections = [
      { id: 'section-1', header: 'Existing summary', lines: [{ id: 'line-1', text: 'Old', ts: 1 }] }
    ]
    engine.tail = [{ id: 'line-2', text: 'Trailing', ts: 2 }]

    engine.reset()

    expect(engine.frozenSections).toEqual([])
    expect(engine.tail).toEqual([])
  })
})
