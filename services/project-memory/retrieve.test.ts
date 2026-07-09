import { describe, expect, it, vi } from 'vitest'
import type { ProjectMemoryFile } from './types'
import {
  MEMORY_BLOCK_HEADER,
  SelectionCache,
  buildCatalog,
  buildProjectMemoryContext,
  estimateTokens,
  formatMemoryBlock,
  parseStageASelection,
  releaseWholeFiles,
  selectFiles,
  truncateToTokens
} from './retrieve'

const file = (id: string, over: Partial<ProjectMemoryFile> = {}): ProjectMemoryFile => ({
  id,
  scopeKind: 'space',
  scopeId: 's1',
  name: `${id}.md`,
  mimeType: 'text/markdown',
  size: 100,
  title: `Title ${id}`,
  description: `Description ${id}`,
  status: 'indexed',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over
})

describe('buildCatalog', () => {
  it('includes only indexed files', () => {
    const cat = buildCatalog([file('a'), file('b', { status: 'failed' }), file('c', { status: 'extracting' })])
    expect(cat.map((c) => c.id)).toEqual(['a'])
  })

  it('falls back to filename and mime type when title/description are blank', () => {
    const [c] = buildCatalog([file('a', { title: ' ', description: '' })])
    expect(c.title).toBe('a.md')
    expect(c.description).toBe('text/markdown file')
  })
})

describe('parseStageASelection', () => {
  const ids = new Set(['a', 'b', 'c', 'd', 'e'])

  it('parses clean JSON', () => {
    const sel = parseStageASelection('{"files":[{"id":"a","reason":"prd"},{"id":"b"}]}', ids)
    expect(sel.files.map((f) => f.id)).toEqual(['a', 'b'])
    expect(sel.files[0].reason).toBe('prd')
  })

  it('strips code fences and surrounding prose', () => {
    const raw = 'Sure! Here you go:\n```json\n{"files":[{"id":"c"}]}\n```\nHope that helps.'
    expect(parseStageASelection(raw, ids).files.map((f) => f.id)).toEqual(['c'])
  })

  it('drops unknown ids, duplicates, and caps at 4', () => {
    const raw = JSON.stringify({
      files: [{ id: 'x' }, { id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]
    })
    expect(parseStageASelection(raw, ids).files.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns zero files on garbage, non-JSON, and wrong shapes', () => {
    expect(parseStageASelection('total nonsense', ids).files).toEqual([])
    expect(parseStageASelection('{"files": "nope"}', ids).files).toEqual([])
    expect(parseStageASelection('', ids).files).toEqual([])
    expect(parseStageASelection('{broken json', ids).files).toEqual([])
  })
})

describe('selectFiles', () => {
  it('skips the call entirely on an empty catalog', async () => {
    const call = vi.fn()
    const sel = await selectFiles([], 'task', call)
    expect(sel.files).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('returns zero files when the call throws', async () => {
    const call = vi.fn().mockRejectedValue(new Error('network'))
    const sel = await selectFiles(buildCatalog([file('a')]), 'task', call)
    expect(sel.files).toEqual([])
  })

  it('memoizes near-identical contexts via the cache', async () => {
    const call = vi.fn().mockResolvedValue('{"files":[{"id":"a"}]}')
    const cache = new SelectionCache()
    const catalog = buildCatalog([file('a')])
    await selectFiles(catalog, 'build the PRD summary', call, cache)
    await selectFiles(catalog, 'build   the PRD summary', call, cache) // whitespace-normalized same bucket
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('re-selects when the catalog changes', async () => {
    const call = vi.fn().mockResolvedValue('{"files":[]}')
    const cache = new SelectionCache()
    await selectFiles(buildCatalog([file('a')]), 'task', call, cache)
    await selectFiles(buildCatalog([file('a'), file('b')]), 'task', call, cache)
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe('token caps', () => {
  it('estimates CJK-heavy text as ~1 token per char', () => {
    expect(estimateTokens('这是一个测试')).toBe(6)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('truncateToTokens leaves small text alone and cuts big text', () => {
    const small = truncateToTokens('hello', 100)
    expect(small).toEqual({ text: 'hello', truncated: false })
    const big = truncateToTokens('x'.repeat(10_000), 100)
    expect(big.truncated).toBe(true)
    expect(big.text.endsWith('[truncated]')).toBe(true)
    expect(estimateTokens(big.text)).toBeLessThanOrEqual(100 + 4) // marker allowance
  })
})

describe('releaseWholeFiles', () => {
  const catalog = buildCatalog([file('a'), file('b'), file('c')])
  const texts: Record<string, string> = {
    a: 'alpha '.repeat(100),
    b: 'beta '.repeat(100),
    c: 'gamma '.repeat(100)
  }
  const getText = async (id: string) => texts[id]

  it('releases in selection order', async () => {
    const out = await releaseWholeFiles({ files: [{ id: 'c' }, { id: 'a' }] }, catalog, getText)
    expect(out.map((f) => f.id)).toEqual(['c', 'a'])
    expect(out[0].truncated).toBe(false)
  })

  it('applies the per-file cap', async () => {
    const out = await releaseWholeFiles({ files: [{ id: 'a' }] }, catalog, getText, { perFileTokens: 50 })
    expect(out[0].truncated).toBe(true)
    expect(estimateTokens(out[0].text)).toBeLessThanOrEqual(54)
  })

  it('fills the total budget in order and drops overflow', async () => {
    const out = await releaseWholeFiles(
      { files: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      catalog,
      getText,
      { perFileTokens: 120, totalTokens: 250 }
    )
    // a (150 tokens) fits; b squeezed into the remainder; c has <200 left → dropped.
    expect(out.map((f) => f.id)).toEqual(['a', 'b'])
    expect(estimateTokens(out[0].text) + estimateTokens(out[1].text)).toBeLessThanOrEqual(250 + 8)
  })

  it('skips files whose text is missing or errors, without throwing', async () => {
    const flaky = async (id: string) => {
      if (id === 'a') throw new Error('boom')
      if (id === 'b') return undefined
      return texts[id]
    }
    const out = await releaseWholeFiles({ files: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, catalog, flaky)
    expect(out.map((f) => f.id)).toEqual(['c'])
  })
})

describe('formatMemoryBlock', () => {
  it('labels the block as untrusted reference data with per-file sections', () => {
    const block = formatMemoryBlock([
      { id: 'a', title: 'PRD v2', text: 'contents here', truncated: false },
      { id: 'b', title: 'Notes', text: 'more', truncated: true }
    ])
    expect(block.startsWith(MEMORY_BLOCK_HEADER)).toBe(true)
    expect(block).toContain('--- FILE: PRD v2 ---')
    expect(block).toContain('--- FILE: Notes (truncated) ---')
    expect(block).toContain('--- END OF REFERENCE MATERIAL ---')
  })

  it('returns empty string for no files', () => {
    expect(formatMemoryBlock([])).toBe('')
  })
})

describe('buildProjectMemoryContext', () => {
  it('returns null on empty catalog without calling the model', async () => {
    const call = vi.fn()
    const ctx = await buildProjectMemoryContext({
      files: [file('a', { status: 'failed' })],
      task: 't',
      getText: async () => 'x',
      call
    })
    expect(ctx).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it('returns null when the model selects nothing', async () => {
    const ctx = await buildProjectMemoryContext({
      files: [file('a')],
      task: 't',
      getText: async () => 'x',
      call: async () => '{"files":[]}'
    })
    expect(ctx).toBeNull()
  })

  it('produces a formatted block and file metadata on the happy path', async () => {
    const ctx = await buildProjectMemoryContext({
      files: [file('a'), file('b')],
      task: 'summarize the prd',
      getText: async (id) => (id === 'a' ? 'the prd body' : 'other'),
      call: async () => '{"files":[{"id":"a"}]}'
    })
    expect(ctx).not.toBeNull()
    expect(ctx!.files).toEqual([{ id: 'a', title: 'Title a', truncated: false }])
    expect(ctx!.block).toContain('the prd body')
    expect(ctx!.block).toContain(MEMORY_BLOCK_HEADER)
  })
})
