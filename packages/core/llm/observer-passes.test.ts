// Integration tests for the observer passes against a mock provider (no network,
// no keys), matching passes.test.ts conventions.

import { describe, it, expect } from 'vitest'
import { observerEvaluate, observerContribute } from './observer-passes'
import { TEST_PROVIDER, jsonResponse, mockFetchSequence } from './__mocks__/mock-provider'
import type { ObserverContributorInput, ObserverEvaluatorInput } from './observer-types'

const evalInput: ObserverEvaluatorInput = {
  signals: [{ text: 'we chose local-first sync', type: 'decision', ts: 1 }],
  canvasSummary: 'Storage: SQLite',
  recentObserverTopics: [],
  kept: [],
  rejected: [],
  dominantLanguage: 'en'
}

const contribInput: ObserverContributorInput = {
  decision: {
    emit: true,
    confidence: 0.8,
    opportunityType: 'missing-angle',
    topic: 'offline conflicts',
    reason: 'no conflict handling yet',
    needsResearch: true
  },
  signals: [{ text: 'offline edits?', type: 'objection', ts: 2 }],
  canvasSummary: 'Storage: SQLite'
}

describe('observerEvaluate (integration)', () => {
  it('parses a good decision and sends the evaluator system prompt + JSON params', async () => {
    const mock = mockFetchSequence([
      jsonResponse(
        '{"emit":true,"confidence":0.7,"opportunityType":"risk","topic":"conflict sync","reason":"r","needsResearch":false}'
      )
    ])
    const out = await observerEvaluate(TEST_PROVIDER, evalInput, mock.fetch)
    expect(out.decision).toMatchObject({ emit: true, opportunityType: 'risk', topic: 'conflict sync' })
    expect(out.error).toBeUndefined()
    expect(out.model).toBe(TEST_PROVIDER.model)
    expect(mock.calls[0].body.messages[0].content).toContain('SILENT observer')
    // JSON reasoning params request a JSON object response.
    expect(JSON.stringify(mock.calls[0].body)).toMatch(/json/i)
  })

  it('accepts a silent emit:false decision', async () => {
    const mock = mockFetchSequence([jsonResponse('{"emit":false,"confidence":0.1}')])
    const out = await observerEvaluate(TEST_PROVIDER, evalInput, mock.fetch)
    expect(out.decision).toEqual({ emit: false, confidence: 0.1 })
  })

  it('returns parse diagnostics on unparseable output (no retry)', async () => {
    const mock = mockFetchSequence([jsonResponse('the model rambled without JSON')])
    const out = await observerEvaluate(TEST_PROVIDER, evalInput, mock.fetch)
    expect(out.decision).toBeNull()
    expect(out.error).toMatch(/unparseable-response/)
    expect(out.error).toMatch(/reasoning_content=absent/)
  })

  it('raises the evaluator token budget to leave room for reasoning models', async () => {
    const mock = mockFetchSequence([jsonResponse('{"emit":false,"confidence":0.1}')])
    await observerEvaluate(TEST_PROVIDER, evalInput, mock.fetch)
    expect(mock.calls[0].body.max_tokens).toBe(3000)
  })

  it('maps an HTTP failure to a null decision + error (never throws)', async () => {
    const mock = mockFetchSequence([jsonResponse('boom', { status: 500 })])
    const out = await observerEvaluate(TEST_PROVIDER, evalInput, mock.fetch)
    expect(out.decision).toBeNull()
    expect(out.error).toMatch(/LLM 500/)
  })
})

describe('observerContribute (integration)', () => {
  it('parses the KEYWORD/bullet protocol and captures the SEARCH line', async () => {
    const mock = mockFetchSequence([
      jsonResponse('KEYWORD: Offline sync\n- Conflict resolution is separate from DB choice.\n- Compare CRDT vs LWW.\nSEARCH: crdt offline conflict')
    ])
    const out = await observerContribute(TEST_PROVIDER, contribInput, mock.fetch)
    expect(out.contribution).toEqual({
      keyword: 'Offline sync',
      bullets: ['Conflict resolution is separate from DB choice.', 'Compare CRDT vs LWW.'],
      searchQuery: 'crdt offline conflict'
    })
    expect(mock.calls[0].body.messages[0].content).toContain('KEYWORD:')
  })

  it('returns parse diagnostics on malformed output', async () => {
    const mock = mockFetchSequence([jsonResponse('no keyword here, just prose')])
    const out = await observerContribute(TEST_PROVIDER, contribInput, mock.fetch)
    expect(out.contribution).toBeNull()
    expect(out.error).toMatch(/unparseable-response/)
    expect(out.error).toMatch(/reasoning_content=absent/)
  })

  it('gives the contributor enough output budget for reasoning models', async () => {
    const mock = mockFetchSequence([jsonResponse('KEYWORD: Topic\n- useful angle')])
    await observerContribute(TEST_PROVIDER, contribInput, mock.fetch)
    expect(mock.calls[0].body.max_tokens).toBe(3000)
  })

  it('maps an HTTP failure to a null contribution + error', async () => {
    const mock = mockFetchSequence([jsonResponse('boom', { status: 503 })])
    const out = await observerContribute(TEST_PROVIDER, contribInput, mock.fetch)
    expect(out.contribution).toBeNull()
    expect(out.error).toMatch(/LLM 503/)
  })
})
