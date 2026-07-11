// Browser-side PDF text extraction (Part B). Loaded ONLY via dynamic import
// from ingestion.ts when a PDF is actually uploaded, so pdfjs-dist (and its
// worker) never lands in the initial bundle — and never loads under vitest.
//
// Mirrors the ExtractTextBrowser contract: decode failures are reported, the
// output is capped at PM_TEXT_CHAR_CAP, and this module never throws.

import { PM_TEXT_CHAR_CAP } from './types'

export type PdfExtractResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: 'decode-error' }

export async function extractPdfText(blob: Blob): Promise<PdfExtractResult> {
  try {
    const pdfjs = await import('pdfjs-dist')
    // Vite turns the ?url import into an asset URL the worker loads from.
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

    const data = new Uint8Array(await blob.arrayBuffer())
    const task = pdfjs.getDocument({ data })
    const doc = await task.promise
    try {
      const parts: string[] = []
      let length = 0
      for (let i = 1; i <= doc.numPages && length <= PM_TEXT_CHAR_CAP; i++) {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        let pageText = ''
        for (const item of content.items) {
          if ('str' in item) {
            pageText += item.str
            if (item.hasEOL) pageText += '\n'
            else if (item.str) pageText += ' '
          }
        }
        const trimmed = pageText.trim()
        if (trimmed) {
          parts.push(trimmed)
          length += trimmed.length + 1
        }
      }
      const text = parts.join('\n')
      if (text.length > PM_TEXT_CHAR_CAP) {
        return { ok: true, text: text.slice(0, PM_TEXT_CHAR_CAP), truncated: true }
      }
      return { ok: true, text, truncated: false }
    } finally {
      await task.destroy().catch(() => {})
    }
  } catch {
    // Encrypted, corrupt, or not actually a PDF — surface as unreadable.
    return { ok: false, reason: 'decode-error' }
  }
}
