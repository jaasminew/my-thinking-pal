import { describe, expect, it } from 'vitest'
import { requestCocreate } from './cocreate'
import { requestCommandChat } from './command-chat'
import type { ProjectMemoryContext } from '../../shared-contract/project-memory'
import {
  COCREATE_SYSTEM,
  COMMAND_CHAT_SYSTEM,
  COMMAND_SYSTEM,
  SEARCH_INSTRUCTION,
  formatProjectInstructions,
  prependMemoryBlock
} from '../../packages/core/llm'
import { TEST_PROVIDER, sseResponse, mockFetchRouter } from '../../packages/core/llm/__mocks__/mock-provider'

// Prompt-assembly order is contractual (docs/modules/09-project-memory.md):
//   system  = base + formatProjectInstructions(...) + searchInstruction
//   user    = memory block (untrusted-data framing) BEFORE transcript/notes.

const memory: ProjectMemoryContext = {
  block: 'Reference material from user-uploaded project files. [PRD CONTENTS]',
  files: [{ id: 'f1', title: 'PRD', truncated: false }]
}

const chatRoute = () => ({
  match: (u: string) => u.includes('/chat/completions'),
  respond: () => sseResponse(['- ok\n'])
})

describe('formatProjectInstructions / prependMemoryBlock', () => {
  it('contribute nothing when empty', () => {
    expect(formatProjectInstructions()).toBe('')
    expect(formatProjectInstructions('  ')).toBe('')
    expect(prependMemoryBlock('user text')).toBe('user text')
    expect(prependMemoryBlock('user text', ' ')).toBe('user text')
  })

  it('label their sections when present', () => {
    expect(formatProjectInstructions('Answer in Chinese')).toContain('PROJECT INSTRUCTIONS')
    expect(prependMemoryBlock('user text', 'BLOCK')).toBe('BLOCK\n\nuser text')
  })
})

describe('cocreate prompt assembly', () => {
  it('orders system as base + instructions + search, and puts the memory block first in the user message', async () => {
    const mock = mockFetchRouter([chatRoute()])
    await requestCocreate(
      {
        seedText: 'idea',
        transcriptWindow: 'spoken words',
        provider: 'open',
        openSub: 'groq',
        webSearch: true,
        projectInstructions: 'Prefer concrete B2B examples',
        projectMemory: memory
      },
      { onText: () => {} },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    const body = mock.calls.find((c) => c.url.includes('/chat/completions'))!.body
    const system: string = body.messages[0].content
    const user: string = body.messages[1].content

    expect(system.startsWith(COCREATE_SYSTEM)).toBe(true)
    const insAt = system.indexOf('PROJECT INSTRUCTIONS')
    const searchAt = system.indexOf(SEARCH_INSTRUCTION.trim())
    expect(insAt).toBeGreaterThan(0)
    expect(searchAt).toBeGreaterThan(insAt)
    expect(system).toContain('Prefer concrete B2B examples')

    expect(user.startsWith(memory.block)).toBe(true)
    expect(user.indexOf(memory.block)).toBeLessThan(user.indexOf('spoken words'))
  })

  it('command path (Tier-3) gets the same treatment on COMMAND_SYSTEM', async () => {
    const mock = mockFetchRouter([chatRoute()])
    await requestCocreate(
      {
        seedText: '',
        command: 'find competitors',
        provider: 'open',
        openSub: 'groq',
        projectInstructions: 'Always cite sources',
        projectMemory: memory
      },
      { onText: () => {} },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    const body = mock.calls[0].body
    expect(body.messages[0].content.startsWith(COMMAND_SYSTEM)).toBe(true)
    expect(body.messages[0].content).toContain('Always cite sources')
    expect(body.messages[1].content.startsWith(memory.block)).toBe(true)
  })

  it('omits both sections when the request carries no memory fields', async () => {
    const mock = mockFetchRouter([chatRoute()])
    await requestCocreate(
      { seedText: 'idea', provider: 'open', openSub: 'groq' },
      { onText: () => {} },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    const body = mock.calls[0].body
    expect(body.messages[0].content).toBe(COCREATE_SYSTEM)
    expect(body.messages[1].content).not.toContain('PROJECT INSTRUCTIONS')
  })
})

describe('command-chat prompt assembly', () => {
  it('appends instructions to the system and prepends the memory block to the prompt', async () => {
    const mock = mockFetchRouter([chatRoute()])
    await requestCommandChat(
      {
        provider: 'open',
        openSub: 'groq',
        messages: [{ role: 'user', text: 'what does the PRD say?' }],
        context: { selectedText: 'selected words', sourceNoteId: 'n1' },
        projectInstructions: 'Be terse',
        projectMemory: memory
      },
      { onText: () => {} },
      undefined,
      { provider: TEST_PROVIDER, fetchImpl: mock.fetch }
    )
    const body = mock.calls[0].body
    const system: string = body.messages[0].content
    const user: string = body.messages[1].content

    expect(system.startsWith(COMMAND_CHAT_SYSTEM)).toBe(true)
    expect(system).toContain('Be terse')
    expect(user.startsWith(memory.block)).toBe(true)
    expect(user.indexOf(memory.block)).toBeLessThan(user.indexOf('selected words'))
  })
})
