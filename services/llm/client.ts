import type {
  ExtractSignalsRequest,
  ExtractSignalsResult,
  OrganizeRequest,
  OrganizeResult,
  SectionHeaderRequest,
  SectionHeaderResult
} from './types'

// Extraction pass: raw speech window -> typed pending signals. A transport
// failure returns skipped=true so the engine puts the raw back and retries —
// only a successfully parsed EMPTY list means "discard this window".
export async function requestExtractSignals(req: ExtractSignalsRequest): Promise<ExtractSignalsResult> {
  try {
    const r = await fetch('/api/extract-signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })
    return (await r.json()) as ExtractSignalsResult
  } catch (e: any) {
    return { signals: [], skipped: true, serverMs: 0, error: e?.message || String(e) }
  }
}

// Organize pass: pending signals -> titled sections (may merge/reword unlocked
// lines). Async, higher-latency (thinking model). On any failure it returns
// empty sections so the engine simply treats the round as "no organize" — never
// an error.
export async function requestOrganize(req: OrganizeRequest): Promise<OrganizeResult> {
  try {
    const r = await fetch('/api/organize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    })
    return (await r.json()) as OrganizeResult
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
