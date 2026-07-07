import { describe, it, expect } from 'vitest'
import { requestExtractSignals, requestOrganize, requestSectionHeader } from './client'
import { TEST_PROVIDER, jsonResponse, mockFetchSequence } from '../../packages/core/llm/__mocks__/mock-provider'

// The client contract is preserved while the implementation went client-direct.
// We inject a mock provider + fetch so no network/key is required.
describe('requestExtractSignals (client-direct contract)', () => {
  it('returns the ExtractSignalsResult shape from a good reply', async () => {
    const mock = mockFetchSequence([jsonResponse('{"signals":[{"type":"decision","text":"Ship."}]}')])
    const res = await requestExtractSignals(
      { systemPrompt: 'p', rawText: 'we ship', provider: 'groq' },
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    expect(res.signals).toEqual([{ type: 'decision', text: 'Ship.' }])
    expect(res.skipped).toBeUndefined()
    expect(res.model).toBe(TEST_PROVIDER.model)
  })

  it('maps an HTTP error to skipped=true (retry), never throws', async () => {
    const mock = mockFetchSequence([jsonResponse('boom', { status: 500 })])
    const res = await requestExtractSignals(
      { systemPrompt: 'p', rawText: 'x', provider: 'groq' },
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    expect(res.skipped).toBe(true)
  })
})

describe('requestOrganize (client-direct contract)', () => {
  it('returns parsed sections', async () => {
    const mock = mockFetchSequence([jsonResponse('{"sections":[{"header":"H","items":[{"src":[0]}]}]}')])
    const res = await requestOrganize(
      { lines: '0 [decision]: a', provider: 'groq' },
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    expect(res.sections).toEqual([{ header: 'H', items: [{ src: [0] }] }])
  })

  it('returns empty sections on failure', async () => {
    const mock = mockFetchSequence([jsonResponse('err', { status: 503 })])
    const res = await requestOrganize(
      { lines: 'x', provider: 'codex' },
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    expect(res.sections).toEqual([])
    expect(res.error).toMatch(/LLM 503/)
  })
})

describe('requestSectionHeader (client-direct contract)', () => {
  it('returns a cleaned header', async () => {
    const mock = mockFetchSequence([jsonResponse('"Storage design"')])
    const res = await requestSectionHeader(
      { body: 'notes', provider: 'groq' },
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    expect(res.header).toBe('Storage design')
  })
})
