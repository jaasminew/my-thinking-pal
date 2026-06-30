import type {
  CleanTranscriptRequest,
  CleanTranscriptResult,
  HighlightRequest,
  HighlightResult
} from './types'

// Reusable Tier-1 highlight service. The browser calls our /api/highlight,
// which proxies to the chosen open-source model. Same module the integrated
// demo will import — UI never talks to a model directly.
export async function requestHighlights(req: HighlightRequest): Promise<HighlightResult> {
  try {
    const r = await fetch('/api/highlight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })
    return (await r.json()) as HighlightResult
  } catch (e: any) {
    return { phrases: [], serverMs: 0, error: e?.message || String(e) }
  }
}

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
