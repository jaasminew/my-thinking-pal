import { describe, it, expect } from 'vitest'
import {
  buildCocreateContext,
  buildCommandContext,
  buildCommandChatPrompt,
  buildExtractSignalsUserText
} from './context'

describe('buildCocreateContext', () => {
  it('numbers the note bullets and appends the focus prompt', () => {
    const out = buildCocreateContext('modular storage', ['first point', 'second point'])
    expect(out).toContain('0. first point')
    expect(out).toContain('1. second point')
    expect(out).toContain("The user's current focus")
    expect(out.trim().endsWith('Add your single new increment now.')).toBe(true)
  })

  it('includes kept/rejected/existing steering when present', () => {
    const out = buildCocreateContext('x', [], undefined, {
      kept: ['good one'],
      rejected: ['bad one'],
      existingIdeas: ['already here']
    })
    expect(out).toContain('KEPT')
    expect(out).toContain('good one')
    expect(out).toContain('REJECTED')
    expect(out).toContain('do NOT repeat')
  })

  it('adds the spoken seedType annotation', () => {
    const out = buildCocreateContext('x', [], undefined, undefined, undefined, 'decision')
    expect(out).toContain('(spoken as a decision)')
  })
})

describe('buildCommandContext', () => {
  it('always ends with the command block', () => {
    const out = buildCommandContext('search voice tools', ['note a'])
    expect(out).toContain('Notes already on the canvas')
    expect(out).toContain('Command:\nsearch voice tools')
  })
})

describe('buildCommandChatPrompt', () => {
  it('flattens history and injects source-note context', () => {
    const out = buildCommandChatPrompt(
      [
        { role: 'user', text: 'what is this' },
        { role: 'assistant', text: 'it is X' }
      ],
      { selectedText: 'the thing', sourceNote: { keyword: 'Topic', humanBullets: ['a'] } }
    )
    expect(out).toContain('Keyword: Topic')
    expect(out).toContain('SELECTED TEXT')
    expect(out).toContain('User: what is this')
    expect(out).toContain('You: it is X')
    expect(out.trim().endsWith('Respond to the last user message now.')).toBe(true)
  })
})

describe('buildExtractSignalsUserText', () => {
  it('includes existing signals as context and the new window', () => {
    const out = buildExtractSignalsUserText('[S1] we should ship', 'prior line')
    expect(out).toContain('already extracted')
    expect(out).toContain('prior line')
    expect(out).toContain('New raw speech window')
    expect(out).toContain('[S1] we should ship')
  })

  it('omits the existing block when none given', () => {
    const out = buildExtractSignalsUserText('hello')
    expect(out).not.toContain('already extracted')
  })
})
