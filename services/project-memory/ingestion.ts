// H2 — Browser text extraction (no AI).
//
// Turns a Blob into plain text for the formats the browser can handle without
// a server: .txt, .md, .csv, .json inline, and .pdf via a lazily-loaded
// pdfjs-dist module (ingestion-pdf.ts) so the PDF engine never lands in the
// initial bundle. Office extraction stays server-side (H7). Format is decided
// by mimeType first, then filename extension. Output is capped at
// PM_TEXT_CHAR_CAP with a `truncated` flag. Unsupported types return
// { ok:false, reason:'unsupported' }; unreadable input returns
// { ok:false, reason:'decode-error' } — this function NEVER throws.

import type { ExtractTextBrowser } from './types'
import { PM_TEXT_CHAR_CAP } from './types'

const SUPPORTED_MIME = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/csv',
  'application/json'
])

const SUPPORTED_EXT = new Set(['txt', 'md', 'csv', 'json'])

/** mimeType takes precedence; fall back to the filename extension. */
function isSupported(mimeType: string, name: string): boolean {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim()
  if (mime && SUPPORTED_MIME.has(mime)) return true
  const ext = (name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] ?? ''
  return SUPPORTED_EXT.has(ext)
}

/** PDF is handled by the lazily-loaded pdfjs module, not the UTF-8 path. */
export function isPdf(mimeType: string, name: string): boolean {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim()
  return mime === 'application/pdf' || /\.pdf$/i.test(name || '')
}

export const extractTextBrowser: ExtractTextBrowser = async (blob, name, mimeType) => {
  if (isPdf(mimeType, name)) {
    const { extractPdfText } = await import('./ingestion-pdf')
    return extractPdfText(blob)
  }
  if (!isSupported(mimeType, name)) {
    return { ok: false, reason: 'unsupported' }
  }

  let decoded: string
  try {
    // fatal:true so genuinely non-UTF-8 bytes surface as a decode failure
    // rather than silent U+FFFD replacement.
    const buf = await blob.arrayBuffer()
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return { ok: false, reason: 'decode-error' }
  }

  if (decoded.length > PM_TEXT_CHAR_CAP) {
    return { ok: true, text: cutAtCodeUnitBoundary(decoded, PM_TEXT_CHAR_CAP), truncated: true }
  }
  return { ok: true, text: decoded, truncated: false }
}

// A raw index slice can land inside a UTF-16 surrogate pair, corrupting the
// trailing character. Back off one unit when the cut splits a high surrogate
// from its low surrogate.
function cutAtCodeUnitBoundary(s: string, cap: number): string {
  const code = s.charCodeAt(cap - 1)
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff
  return s.slice(0, isHighSurrogate ? cap - 1 : cap)
}
