// Streaming line/text filters — small state machines that classify a model's
// token stream on the fly. Pure (no transport): they take emit callbacks and are
// fed text via push()/flush(), which makes them exhaustively unit-testable.

import type { UrlCard } from './types'

// Line filter for the ACTION/SOURCE protocols (command-chat). Whole lines only: a chunk
// boundary can split "ACT|ION:", so classifying anything smaller would leak
// protocol text into chat. ACTION lines go to onAction as raw JSON; every other
// line streams through as chat text (blank lines are paragraph breaks).
export function makeCommandActionFilter(
  emitText: (t: string) => void,
  onAction: (rawJson: string) => void,
  onSource?: (rawJson: string) => void
) {
  let buf = ''
  const handleLine = (l: string) => {
    const m = l.match(/^\s*ACTION:\s*(\{.*\})\s*$/)
    if (m) {
      onAction(m[1])
      return
    }
    const source = l.match(/^\s*SOURCE:\s*(\{.*\})\s*$/)
    if (source) {
      onSource?.(source[1])
      return
    }
    emitText(l + '\n')
  }
  return {
    push(text: string) {
      buf += text
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    },
    flush() {
      if (buf.trim()) handleLine(buf)
      buf = ''
    }
  }
}

// Line-level filter for the diagnose-then-contribute protocol. Captures the
// leading "DIAGNOSIS: …" line (own event, never shown), the "ANCHOR: <n>|NONE"
// line (placement), and a bare "PASS" line (suppressed), passing every other
// completed line through.
export function makeProtocolFilter(
  emit: (text: string) => void,
  onDiagnosis: (d: string) => void,
  onAnchor?: (line: number) => void
) {
  let buf = ''
  let passed = false
  let contentLines = 0
  const handleLine = (l: string) => {
    const dm = l.match(/^\s*DIAGNOSIS:\s*(.*)$/i)
    if (dm) {
      if (dm[1].trim()) onDiagnosis(dm[1].trim())
      return
    }
    const am = l.match(/^\s*ANCHOR:\s*(\S+)/i)
    if (am) {
      const n = parseInt(am[1], 10)
      if (Number.isFinite(n) && n >= 0) onAnchor?.(n) // "NONE" parses NaN → no event
      return
    }
    if (/^\s*PASS[.!]?\s*$/i.test(l)) {
      passed = true
      return
    }
    if (l.trim()) {
      contentLines++
      emit(l + '\n')
    }
  }
  return {
    push(text: string) {
      buf += text
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    },
    flush() {
      if (buf.trim()) handleLine(buf)
      buf = ''
    },
    get passed() {
      return passed
    },
    get contentLines() {
      return contentLines
    }
  }
}

// Strips markdown/bare links out of streamed bullet text (the canvas renders raw
// text) and surfaces them as URL cards / inline images instead. Streaming-safe:
// a trailing fragment that may still be a link is held back until the next chunk.
export function makeLinkStripper(
  emit: (text: string) => void,
  onUrl: (u: UrlCard) => void,
  onImage?: (im: { title: string; url: string }) => void
) {
  let buf = ''
  const MD_IMG = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g
  const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g
  const process = (final: boolean) => {
    let s = buf.replace(MD_IMG, (_, title: string, url: string) => {
      onImage?.({ title: title || url, url })
      return title
    })
    s = s.replace(MD_LINK, (_, title: string, url: string) => {
      onUrl({ title: title || url, url })
      return title
    })
    s = s.replace(/https?:\/\/[^\s)\]]+(?=\s)/g, (url) => {
      onUrl({ title: url, url })
      return ''
    })
    if (final) {
      s = s.replace(/https?:\/\/[^\s)\]]+/g, (url) => {
        onUrl({ title: url, url })
        return ''
      })
      buf = ''
      if (s) emit(s)
      return
    }
    let hold = s.length
    const lb = s.lastIndexOf('[')
    if (lb >= 0 && !s.slice(lb).includes(')')) hold = Math.min(hold, lb > 0 && s[lb - 1] === '!' ? lb - 1 : lb)
    const tailUrl = s.match(/https?:\/\/\S*$/)
    if (tailUrl?.index !== undefined) hold = Math.min(hold, tailUrl.index)
    if (hold > 0) emit(s.slice(0, hold))
    buf = s.slice(hold)
  }
  return {
    push(text: string) {
      buf += text
      process(false)
    },
    flush() {
      process(true)
    }
  }
}
