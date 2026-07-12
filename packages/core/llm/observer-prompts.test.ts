import { describe, it, expect } from 'vitest'
import {
  buildObserverContributorSystem,
  buildObserverContributorUserText,
  buildObserverEvaluatorSystem,
  buildObserverEvaluatorUserText
} from './observer-prompts'
import type { ObserverContributorInput, ObserverEvaluatorInput } from './observer-types'

const evalInput: ObserverEvaluatorInput = {
  signals: [
    { text: 'we will sync notes with a local database', type: 'decision', speaker: 'S1', ts: 10 },
    { text: 'but what if two people edit offline?', type: 'objection', ts: 20 }
  ],
  transcriptWindow: 'S1: we will sync notes locally. S2: but offline edits?',
  canvasSummary: 'Note: Storage choice — settled on SQLite for the local store.',
  recentObserverTopics: ['pricing model'],
  kept: ['comparison of vector databases'],
  rejected: ['use Redis for caching'],
  dominantLanguage: 'en'
}

describe('evaluator prompts', () => {
  it('system prompt states the precision-first contract and the JSON shape', () => {
    const sys = buildObserverEvaluatorSystem()
    expect(sys).toContain('SILENT observer')
    expect(sys).toMatch(/Silence is a correct/i)
    expect(sys).toContain('"emit"')
    expect(sys).toContain('needsResearch')
    // Lists all seven opportunity types.
    for (const t of ['missing-angle', 'connection', 'comparison', 'risk', 'example', 'question', 'source']) {
      expect(sys).toContain(t)
    }
    // A small-talk → emit:false few-shot is present.
    expect(sys).toContain('{"emit":false')
  })

  it('user text carries the fresh signals, canvas summary, rejected + recent topics, and language tag', () => {
    const user = buildObserverEvaluatorUserText(evalInput)
    expect(user).toContain('Fresh signals')
    expect(user).toContain('sync notes with a local database')
    expect(user).toContain('[objection]')
    expect(user).toContain('Storage choice')
    expect(user).toContain('use Redis for caching') // rejected
    expect(user).toContain('pricing model') // recent observer topic
    expect(user).toContain('comparison of vector databases') // kept
    expect(user).toContain('en') // language tag
  })

  it('omits absent optional sections', () => {
    const user = buildObserverEvaluatorUserText({
      signals: [{ text: 'hello', ts: 1 }],
      canvasSummary: '',
      recentObserverTopics: [],
      kept: [],
      rejected: []
    })
    expect(user).not.toMatch(/REJECTED/)
    expect(user).not.toMatch(/recently raised/)
    expect(user).toContain('hello')
  })
})

describe('contributor prompts', () => {
  it('system prompt fixes the KEYWORD/bullet protocol and bans URLs in bullets', () => {
    const sys = buildObserverContributorSystem()
    expect(sys).toContain('KEYWORD:')
    expect(sys).toMatch(/1 to 3 bullets/i)
    expect(sys).toContain('SEARCH:')
    expect(sys).toMatch(/do NOT put URLs/i)
  })

  it('user text includes the brief and asks for a SEARCH line only when research is needed', () => {
    const base: ObserverContributorInput = {
      decision: {
        emit: true,
        confidence: 0.8,
        opportunityType: 'missing-angle',
        topic: 'offline edit conflicts',
        reason: 'no conflict handling chosen yet',
        needsResearch: true,
        suggestedSearchQuery: 'crdt offline sync'
      },
      signals: [{ text: 'offline edits?', type: 'objection', ts: 5 }],
      canvasSummary: 'Storage: SQLite',
      dominantLanguage: 'zh'
    }
    const needs = buildObserverContributorUserText(base)
    expect(needs).toContain('offline edit conflicts')
    expect(needs).toContain('missing-angle')
    expect(needs).toMatch(/Research: NEEDED/)
    expect(needs).toContain('zh')

    const noResearch = buildObserverContributorUserText({
      ...base,
      decision: { ...base.decision, needsResearch: false }
    })
    expect(noResearch).toMatch(/Research: not needed/)
  })
})
