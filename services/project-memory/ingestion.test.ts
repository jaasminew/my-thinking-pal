import { describe, expect, it, vi } from 'vitest'
import { extractTextBrowser } from './ingestion'
import { PM_TEXT_CHAR_CAP } from './types'

// The real pdfjs module needs a browser worker; here we only assert routing.
vi.mock('./ingestion-pdf', () => ({
  extractPdfText: vi.fn(async () => ({ ok: true, text: 'parsed pdf text', truncated: false }))
}))

const blob = (text: string, type?: string) => new Blob([text], type ? { type } : undefined)

describe('extractTextBrowser — supported formats', () => {
  it('extracts .txt (text/plain)', async () => {
    const r = await extractTextBrowser(blob('hello plain text', 'text/plain'), 'note.txt', 'text/plain')
    expect(r).toEqual({ ok: true, text: 'hello plain text', truncated: false })
  })

  it('extracts .md (text/markdown) as raw text — no markdown parsing', async () => {
    const body = '# Heading\n\nSome **bold** markdown.\n'
    const r = await extractTextBrowser(blob(body, 'text/markdown'), 'doc.md', 'text/markdown')
    expect(r).toEqual({ ok: true, text: body, truncated: false })
  })

  it('extracts .csv (text/csv) as raw text — no field parsing', async () => {
    const body = 'name,age\nAlice,30\nBob,25\n'
    const r = await extractTextBrowser(blob(body, 'text/csv'), 'data.csv', 'text/csv')
    expect(r).toEqual({ ok: true, text: body, truncated: false })
  })

  it('extracts .json (application/json) as raw text — no JSON parsing', async () => {
    const body = '{"a":1,"b":[2,3]}'
    const r = await extractTextBrowser(blob(body, 'application/json'), 'conf.json', 'application/json')
    expect(r).toEqual({ ok: true, text: body, truncated: false })
  })

  it('falls back to the filename extension when mimeType is unknown/empty', async () => {
    const r = await extractTextBrowser(blob('# hi', 'application/octet-stream'), 'readme.md', 'application/octet-stream')
    expect(r).toEqual({ ok: true, text: '# hi', truncated: false })
  })

  it('falls back to extension even with an empty mimeType', async () => {
    const r = await extractTextBrowser(blob('x,y'), 'sheet.csv', '')
    expect(r).toEqual({ ok: true, text: 'x,y', truncated: false })
  })
})

describe('extractTextBrowser — PDF routing (Part B)', () => {
  it('routes a PDF by mime type to the lazy pdf extractor', async () => {
    const r = await extractTextBrowser(blob('%PDF-1.4', 'application/pdf'), 'report.pdf', 'application/pdf')
    expect(r).toEqual({ ok: true, text: 'parsed pdf text', truncated: false })
  })

  it('routes a PDF by extension alone (unknown mime)', async () => {
    const r = await extractTextBrowser(blob('%PDF-1.4'), 'report.pdf', 'application/octet-stream')
    expect(r).toEqual({ ok: true, text: 'parsed pdf text', truncated: false })
  })
})

describe('extractTextBrowser — unsupported formats', () => {
  it('returns unsupported for an unknown extension with no mime hint', async () => {
    const r = await extractTextBrowser(blob('???', 'application/octet-stream'), 'archive.zip', 'application/octet-stream')
    expect(r).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('never throws — even on odd input it returns a result object', async () => {
    const r = await extractTextBrowser(blob('', ''), 'noext', '')
    expect(r).toEqual({ ok: false, reason: 'unsupported' })
  })
})

describe('extractTextBrowser — truncation boundary', () => {
  it('leaves text under the cap un-truncated', async () => {
    const small = 'a'.repeat(PM_TEXT_CHAR_CAP - 1)
    const r = await extractTextBrowser(blob(small, 'text/plain'), 's.txt', 'text/plain')
    expect(r).toMatchObject({ ok: true, truncated: false })
    if (r.ok) expect(r.text.length).toBe(PM_TEXT_CHAR_CAP - 1)
  })

  it('does not truncate text exactly at the cap', async () => {
    const exact = 'b'.repeat(PM_TEXT_CHAR_CAP)
    const r = await extractTextBrowser(blob(exact, 'text/plain'), 'e.txt', 'text/plain')
    expect(r).toMatchObject({ ok: true, truncated: false })
    if (r.ok) expect(r.text.length).toBe(PM_TEXT_CHAR_CAP)
  })

  it('truncates text one char over the cap and flags it', async () => {
    const over = 'c'.repeat(PM_TEXT_CHAR_CAP + 1)
    const r = await extractTextBrowser(blob(over, 'text/plain'), 'o.txt', 'text/plain')
    expect(r).toMatchObject({ ok: true, truncated: true })
    if (r.ok) expect(r.text.length).toBe(PM_TEXT_CHAR_CAP)
  })

  it('never splits a UTF-16 surrogate pair at the truncation boundary', async () => {
    // A non-BMP emoji (2 UTF-16 code units) straddling the cap: filler puts
    // the emoji's high surrogate at index PM_TEXT_CHAR_CAP - 1.
    const filler = 'x'.repeat(PM_TEXT_CHAR_CAP - 1)
    const body = filler + '😀' + 'trailing text'
    const r = await extractTextBrowser(blob(body, 'text/plain'), 'emoji.txt', 'text/plain')
    expect(r).toMatchObject({ ok: true, truncated: true })
    if (!r.ok) return
    // Backed off one unit rather than keeping a lone high surrogate.
    expect(r.text.length).toBe(PM_TEXT_CHAR_CAP - 1)
    expect(r.text).toBe(filler)
    // The result round-trips through a JS string with no unpaired surrogate.
    expect(() => encodeURIComponent(r.text)).not.toThrow()
  })
})

describe('extractTextBrowser — decode errors', () => {
  it('returns decode-error for a supported type with invalid UTF-8 bytes', async () => {
    // 0xFF / 0xFE / 0xFD are invalid UTF-8 lead bytes; fatal decoding throws.
    const bad = new Blob([new Uint8Array([0xff, 0xfe, 0xfd])], { type: 'text/plain' })
    const r = await extractTextBrowser(bad, 'garbage.txt', 'text/plain')
    expect(r).toEqual({ ok: false, reason: 'decode-error' })
  })
})
