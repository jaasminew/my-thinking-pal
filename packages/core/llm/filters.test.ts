import { describe, it, expect } from 'vitest'
import { makeProtocolFilter, makeLinkStripper, makeCommandActionFilter } from './filters'
import type { UrlCard } from './types'

describe('makeProtocolFilter', () => {
  it('captures DIAGNOSIS and ANCHOR, emits only content bullets', () => {
    const text: string[] = []
    let diag = ''
    let anchor = -1
    const f = makeProtocolFilter(
      (t) => text.push(t),
      (d) => (diag = d),
      (a) => (anchor = a)
    )
    f.push('DIAGNOSIS: needs a real case\nANCHOR: 2\n- Notion uses blocks\n')
    f.flush()
    expect(diag).toBe('needs a real case')
    expect(anchor).toBe(2)
    expect(text.join('')).toBe('- Notion uses blocks\n')
    expect(f.contentLines).toBe(1)
    expect(f.passed).toBe(false)
  })

  it('marks passed and emits nothing on PASS', () => {
    const text: string[] = []
    const f = makeProtocolFilter((t) => text.push(t), () => {})
    f.push('DIAGNOSIS: fine\nANCHOR: NONE\nPASS\n')
    f.flush()
    expect(f.passed).toBe(true)
    expect(text).toEqual([])
  })

  it('handles ANCHOR NONE as no anchor event', () => {
    let anchorCalls = 0
    const f = makeProtocolFilter(() => {}, () => {}, () => anchorCalls++)
    f.push('ANCHOR: NONE\n- x\n')
    f.flush()
    expect(anchorCalls).toBe(0)
  })

  it('survives a chunk boundary splitting a protocol line', () => {
    const text: string[] = []
    let diag = ''
    const f = makeProtocolFilter((t) => text.push(t), (d) => (diag = d))
    f.push('DIAG')
    f.push('NOSIS: split line\n- bullet\n')
    f.flush()
    expect(diag).toBe('split line')
    expect(text.join('')).toBe('- bullet\n')
  })
})

describe('makeLinkStripper', () => {
  it('converts a complete markdown link into a card and keeps the title text', () => {
    const urls: UrlCard[] = []
    const out: string[] = []
    const s = makeLinkStripper((t) => out.push(t), (u) => urls.push(u))
    s.push('- [Notion](https://notion.so) stores blocks\n')
    s.flush()
    expect(urls).toEqual([{ title: 'Notion', url: 'https://notion.so' }])
    expect(out.join('')).toContain('Notion stores blocks')
    expect(out.join('')).not.toContain('https://')
  })

  it('routes markdown image syntax to onImage, not onUrl', () => {
    const urls: UrlCard[] = []
    const imgs: { title: string; url: string }[] = []
    const s = makeLinkStripper(() => {}, (u) => urls.push(u), (im) => imgs.push(im))
    s.push('- ![OP-1](https://teenage.engineering/products/op-1) is playful\n')
    s.flush()
    expect(imgs).toEqual([{ title: 'OP-1', url: 'https://teenage.engineering/products/op-1' }])
    expect(urls).toEqual([])
  })

  it('holds back an incomplete link straddling a chunk boundary', () => {
    const urls: UrlCard[] = []
    const out: string[] = []
    const s = makeLinkStripper((t) => out.push(t), (u) => urls.push(u))
    s.push('see [Noti')
    expect(out.join('')).not.toContain('[Noti') // held back
    s.push('on](https://notion.so) here')
    s.flush()
    expect(urls).toEqual([{ title: 'Notion', url: 'https://notion.so' }])
    expect(out.join('')).toContain('see Notion here')
  })

  it('extracts a bare url as a card', () => {
    const urls: UrlCard[] = []
    const s = makeLinkStripper(() => {}, (u) => urls.push(u))
    s.push('ref https://example.com/x\n')
    s.flush()
    expect(urls).toEqual([{ title: 'https://example.com/x', url: 'https://example.com/x' }])
  })
})

describe('makeCommandActionFilter', () => {
  it('separates ACTION json lines from chat prose', () => {
    const text: string[] = []
    const actions: string[] = []
    const f = makeCommandActionFilter((t) => text.push(t), (a) => actions.push(a))
    f.push('Here you go.\nACTION: {"type":"insert-bullet","text":"try Notion"}\nDone.\n')
    f.flush()
    expect(actions).toEqual(['{"type":"insert-bullet","text":"try Notion"}'])
    expect(text.join('')).toBe('Here you go.\nDone.\n')
  })

  it('separates SOURCE json lines from visible chat text', () => {
    const text: string[] = []
    const sources: string[] = []
    const f = makeCommandActionFilter(
      (t) => text.push(t),
      () => {},
      (s) => sources.push(s)
    )
    f.push('Answer.\nSOURCE: {"kind":"web","url":"https://example.com"}\n')
    f.flush()
    expect(text.join('')).toBe('Answer.\n')
    expect(sources).toEqual(['{"kind":"web","url":"https://example.com"}'])
  })
})
