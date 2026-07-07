import { describe, it, expect } from 'vitest'
import { requestCommandChat } from './command-chat'
import type { CommandChatAction } from './command-chat-types'
import { TEST_PROVIDER, sseResponse, rawJsonResponse, mockFetchRouter } from '../../packages/core/llm/__mocks__/mock-provider'

describe('requestCommandChat (client-direct)', () => {
  it('separates prose from ACTION lines and injects the source note id', async () => {
    const text: string[] = []
    const actions: CommandChatAction[] = []
    const mock = mockFetchRouter([
      {
        match: (u) => u.includes('/chat/completions'),
        respond: () =>
          sseResponse([
            'Here are two options.\n',
            'ACTION: {"type":"insert-bullet","text":"try Notion"}\n',
            'ACTION: {"type":"create-note","keyword":"Storage","bullets":["blocks","pages"]}\n'
          ])
      }
    ])
    const res = await requestCommandChat(
      { provider: 'open', openSub: 'groq', messages: [{ role: 'user', text: 'ideas?' }], context: { sourceNoteId: 'note-9' } },
      { onText: (t) => text.push(t), onAction: (a) => actions.push(a) },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    expect(text.join('')).toContain('Here are two options.')
    expect(text.join('')).not.toContain('ACTION:')
    expect(actions).toEqual([
      { type: 'insert-bullet', noteId: 'note-9', text: 'try Notion' },
      { type: 'create-note', keyword: 'Storage', bullets: ['blocks', 'pages'] }
    ])
    expect(res.model).toBe(TEST_PROVIDER.model)
  })

  it('resolves append-image via url-meta, degrading to a card when no image', async () => {
    const actions: CommandChatAction[] = []
    const mock = mockFetchRouter([
      {
        match: (u) => u.includes('/chat/completions'),
        respond: () =>
          sseResponse([
            'Look at this.\n',
            'ACTION: {"type":"append-image","caption":"the UI","url":"https://te.com/op1","title":"OP-1"}\n'
          ])
      },
      { match: (u) => u.includes('/api/url-meta'), respond: () => rawJsonResponse({ image: 'https://te.com/op1.png' }) }
    ])
    await requestCommandChat(
      { provider: 'open', openSub: 'groq', messages: [{ role: 'user', text: 'show me' }], context: { sourceNoteId: 'n1' } },
      { onText: () => {}, onAction: (a) => actions.push(a) },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    expect(actions).toEqual([
      { type: 'append-image', noteId: 'n1', src: 'https://te.com/op1.png', sourceUrl: 'https://te.com/op1', title: 'OP-1', caption: 'the UI' }
    ])
  })

  it('rejects an empty message list', async () => {
    const res = await requestCommandChat(
      { provider: 'open', messages: [], context: {} } as any,
      { onText: () => {} },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mockFetchRouter([]).fetch }
    )
    expect(res.error).toMatch(/messages/)
  })
})
