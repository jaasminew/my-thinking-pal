import { describe, it, expect } from 'vitest'
import { chatCompletion, ChatHttpError } from './chat'
import { TEST_PROVIDER, jsonResponse, mockFetchSequence } from './__mocks__/mock-provider'

describe('chatCompletion', () => {
  it('returns the assistant message content', async () => {
    const mock = mockFetchSequence([jsonResponse('hello world')])
    const { content } = await chatCompletion(TEST_PROVIDER, { system: 's', userText: 'u', fetchImpl: mock.fetch })
    expect(content).toBe('hello world')
    expect(mock.calls[0].body.stream).toBeUndefined()
    expect(mock.calls[0].body.messages).toHaveLength(2)
  })

  it('throws ChatHttpError on non-ok status', async () => {
    const mock = mockFetchSequence([jsonResponse('rate limited', { status: 429 })])
    await expect(
      chatCompletion(TEST_PROVIDER, { system: 's', userText: 'u', fetchImpl: mock.fetch })
    ).rejects.toBeInstanceOf(ChatHttpError)
  })

  it('passes reasoning params through into the body', async () => {
    const mock = mockFetchSequence([jsonResponse('{}')])
    await chatCompletion(TEST_PROVIDER, {
      system: 's',
      userText: 'u',
      fetchImpl: mock.fetch,
      reasoning: { reasoning_effort: 'medium', reasoning_format: 'hidden' }
    })
    expect(mock.calls[0].body.reasoning_effort).toBe('medium')
    expect(mock.calls[0].body.reasoning_format).toBe('hidden')
  })
})
