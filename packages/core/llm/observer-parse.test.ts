import { describe, it, expect } from 'vitest'
import { parseObserverDecision, parseObserverContribution } from './observer-parse'

describe('parseObserverDecision', () => {
  it('parses a valid emit-true decision', () => {
    const raw = JSON.stringify({
      emit: true,
      confidence: 0.8,
      opportunityType: 'risk',
      topic: 'conflict resolution strategy',
      reason: 'the group compared databases but never discussed sync conflicts',
      needsResearch: false,
      suggestedSearchQuery: null
    })
    const d = parseObserverDecision(raw)
    expect(d).toEqual({
      emit: true,
      confidence: 0.8,
      opportunityType: 'risk',
      topic: 'conflict resolution strategy',
      reason: 'the group compared databases but never discussed sync conflicts',
      needsResearch: false
    })
  })

  it('parses a valid emit-false decision (minimal shape)', () => {
    const raw = JSON.stringify({ emit: false, confidence: 0.2 })
    expect(parseObserverDecision(raw)).toEqual({ emit: false, confidence: 0.2 })
  })

  it('parses fenced JSON', () => {
    const raw = '```json\n{"emit": true, "confidence": 0.7, "opportunityType": "question", "topic": "scaling"}\n```'
    expect(parseObserverDecision(raw)).toEqual({
      emit: true,
      confidence: 0.7,
      opportunityType: 'question',
      topic: 'scaling',
      needsResearch: false
    })
  })

  it('parses JSON surrounded by prose', () => {
    const raw = 'Sure, here is my decision:\n{"emit": true, "confidence": 0.6, "opportunityType": "example", "topic": "Yjs CRDT"}\nHope this helps!'
    expect(parseObserverDecision(raw)).toEqual({
      emit: true,
      confidence: 0.6,
      opportunityType: 'example',
      topic: 'Yjs CRDT',
      needsResearch: false
    })
  })

  it('returns null when emit is missing', () => {
    expect(parseObserverDecision('{"confidence": 0.5}')).toBeNull()
  })

  it('returns null when emit is non-boolean', () => {
    expect(parseObserverDecision('{"emit": "yes"}')).toBeNull()
  })

  it('returns null for a bad opportunityType', () => {
    const raw = JSON.stringify({ emit: true, confidence: 0.9, opportunityType: 'gap', topic: 'x' })
    expect(parseObserverDecision(raw)).toBeNull()
  })

  it('returns null for emit-true without topic', () => {
    const raw = JSON.stringify({ emit: true, confidence: 0.9, opportunityType: 'risk' })
    expect(parseObserverDecision(raw)).toBeNull()
  })

  it('returns null for emit-true with empty topic', () => {
    const raw = JSON.stringify({ emit: true, confidence: 0.9, opportunityType: 'risk', topic: '  ' })
    expect(parseObserverDecision(raw)).toBeNull()
  })

  it('defaults non-numeric confidence to 0', () => {
    const raw = JSON.stringify({ emit: false, confidence: 'high' })
    expect(parseObserverDecision(raw)).toEqual({ emit: false, confidence: 0 })
  })

  it('defaults absent confidence to 0', () => {
    expect(parseObserverDecision('{"emit": false}')).toEqual({ emit: false, confidence: 0 })
  })

  it('keeps suggestedSearchQuery only when non-empty', () => {
    const raw = JSON.stringify({
      emit: true,
      confidence: 0.5,
      opportunityType: 'source',
      topic: 'CRDT libs',
      suggestedSearchQuery: 'yjs crdt'
    })
    const d = parseObserverDecision(raw)
    expect(d?.suggestedSearchQuery).toBe('yjs crdt')
  })

  it('drops empty suggestedSearchQuery', () => {
    const raw = JSON.stringify({
      emit: true,
      confidence: 0.5,
      opportunityType: 'source',
      topic: 'CRDT libs',
      suggestedSearchQuery: '  '
    })
    const d = parseObserverDecision(raw)
    expect(d?.suggestedSearchQuery).toBeUndefined()
  })

  it('handles nested JSON objects with braces in strings', () => {
    const raw = '{"emit": true, "confidence": 0.5, "opportunityType": "risk", "topic": "brace } test", "reason": "has } char"}'
    const d = parseObserverDecision(raw)
    expect(d?.topic).toBe('brace } test')
  })

  it('returns null on garbage input', () => {
    expect(parseObserverDecision('the model rambled with no json')).toBeNull()
  })

  it('returns null on unbalanced braces', () => {
    expect(parseObserverDecision('{"emit": true, "confidence": 0.5')).toBeNull()
  })

  it('returns null on empty string', () => {
    expect(parseObserverDecision('')).toBeNull()
  })
})

describe('parseObserverContribution', () => {
  const valid = [
    'KEYWORD: Offline synchronization',
    '- Conflict resolution is a separate decision from database selection.',
    '- Compare last-write-wins, field-level merge, and CRDT approaches.',
    '- Yjs is relevant because the current canvas already uses a CRDT.',
    'SEARCH: yjs crdt conflict resolution'
  ].join('\n')

  it('parses a valid contribution', () => {
    const c = parseObserverContribution(valid)
    expect(c).toEqual({
      keyword: 'Offline synchronization',
      bullets: [
        'Conflict resolution is a separate decision from database selection.',
        'Compare last-write-wins, field-level merge, and CRDT approaches.',
        'Yjs is relevant because the current canvas already uses a CRDT.'
      ],
      searchQuery: 'yjs crdt conflict resolution'
    })
  })

  it('returns null without a KEYWORD line', () => {
    const raw = '- bullet one\n- bullet two'
    expect(parseObserverContribution(raw)).toBeNull()
  })

  it('returns null for an empty KEYWORD value', () => {
    const raw = 'KEYWORD:   \n- bullet one'
    expect(parseObserverContribution(raw)).toBeNull()
  })

  it('returns null with zero bullets', () => {
    const raw = 'KEYWORD: Topic\nSome prose without bullets.'
    expect(parseObserverContribution(raw)).toBeNull()
  })

  it('caps bullets at 3 (keeps first 3, drops rest)', () => {
    const raw = [
      'KEYWORD: Topic',
      '- bullet 1',
      '- bullet 2',
      '- bullet 3',
      '- bullet 4',
      '- bullet 5'
    ].join('\n')
    const c = parseObserverContribution(raw)
    expect(c?.bullets).toEqual(['bullet 1', 'bullet 2', 'bullet 3'])
  })

  it('parses SEARCH line when present', () => {
    const raw = ['KEYWORD: Topic', '- bullet 1', 'SEARCH: crdt sync'].join('\n')
    expect(parseObserverContribution(raw)?.searchQuery).toBe('crdt sync')
  })

  it('omits searchQuery when SEARCH line absent', () => {
    const raw = ['KEYWORD: Topic', '- bullet 1'].join('\n')
    const c = parseObserverContribution(raw)
    expect(c?.searchQuery).toBeUndefined()
  })

  it('ignores an empty SEARCH query', () => {
    const raw = ['KEYWORD: Topic', '- bullet 1', 'SEARCH:   '].join('\n')
    const c = parseObserverContribution(raw)
    expect(c?.searchQuery).toBeUndefined()
  })

  it('first SEARCH occurrence wins', () => {
    const raw = ['KEYWORD: Topic', '- bullet 1', 'SEARCH: first', 'SEARCH: second'].join('\n')
    expect(parseObserverContribution(raw)?.searchQuery).toBe('first')
  })

  it('accepts * bullets', () => {
    const raw = ['KEYWORD: Topic', '* bullet one', '* bullet two'].join('\n')
    const c = parseObserverContribution(raw)
    expect(c?.bullets).toEqual(['bullet one', 'bullet two'])
  })

  it('handles mixed - and * bullets', () => {
    const raw = ['KEYWORD: Topic', '- dash bullet', '* star bullet'].join('\n')
    const c = parseObserverContribution(raw)
    expect(c?.bullets).toEqual(['dash bullet', 'star bullet'])
  })

  it('keyword match is case-insensitive', () => {
    const raw = ['keyword: lowercase topic', '- bullet 1'].join('\n')
    expect(parseObserverContribution(raw)?.keyword).toBe('lowercase topic')
  })

  it('search match is case-insensitive', () => {
    const raw = ['KEYWORD: Topic', '- bullet 1', 'search: lowercase query'].join('\n')
    expect(parseObserverContribution(raw)?.searchQuery).toBe('lowercase query')
  })

  it('SEARCH can appear before bullets', () => {
    const raw = ['KEYWORD: Topic', 'SEARCH: early query', '- bullet 1'].join('\n')
    const c = parseObserverContribution(raw)
    expect(c?.searchQuery).toBe('early query')
    expect(c?.bullets).toEqual(['bullet 1'])
  })

  it('returns null on garbage input', () => {
    expect(parseObserverContribution('totally random text with no structure')).toBeNull()
  })

  it('returns null on empty string', () => {
    expect(parseObserverContribution('')).toBeNull()
  })
})
