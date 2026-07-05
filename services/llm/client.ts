import type {
  CleanTranscriptRequest,
  CleanTranscriptResult,
  SectionHeaderRequest,
  SectionHeaderResult,
  SegmentRequest,
  SegmentResult
} from './types'

export async function requestCleanTranscript(req: CleanTranscriptRequest): Promise<CleanTranscriptResult> {
  try {
    const r = await fetch('/api/clean-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })
    return (await r.json()) as CleanTranscriptResult
  } catch (e: any) {
    return { markedText: '', serverMs: 0, error: e?.message || String(e) }
  }
}

// Structuring pass: send the open tail; get back the closed segments + headers.
// Async, higher-latency (thinking model). On any failure it returns empty
// sections so the engine simply treats the round as "no split" — never an error.
export async function requestSegment(req: SegmentRequest): Promise<SegmentResult> {
  try {
    const r = await fetch('/api/segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })
    return (await r.json()) as SegmentResult
  } catch (e: any) {
    return { sections: [], serverMs: 0, error: e?.message || String(e) }
  }
}

// Summarize a finished (closed) section's body into a short header. Fired async
// on a topic boundary; the header patches in when it resolves.
export async function requestSectionHeader(req: SectionHeaderRequest): Promise<SectionHeaderResult> {
  try {
    const r = await fetch('/api/section-header', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })
    return (await r.json()) as SectionHeaderResult
  } catch (e: any) {
    return { header: '', serverMs: 0, error: e?.message || String(e) }
  }
}
