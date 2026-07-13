import type {
  ExtractSignalsRequest,
  ExtractSignalsResult,
  OrganizeRequest,
  OrganizeResult,
  SectionHeaderRequest,
  SectionHeaderResult
} from './types'
import {
  extractSignals,
  organize,
  sectionHeader,
  type FetchLike,
  type LlmProvider
} from '../../packages/core/llm'
import { resolveClientProvider } from './provider-config'
import { isProviderUsable } from '../../packages/core/llm'
import type { ModelCategory } from '../../packages/core/llm/observer-types'
import { resolveCategoryProvider, type CategoryAssignment } from './model-roles'

// The transcript pipeline (cleanup / summary) now runs CLIENT-DIRECT: these
// functions resolve the user's provider + key and call the OpenAI-compatible
// endpoint straight from the browser (docs module 08). When signed in without
// a personal key, resolveCategoryProvider returns the hosted DeepSeek proxy.

export interface ClientDeps {
  provider?: LlmProvider
  fetchImpl?: FetchLike
  /** Prefer category ladder (hosted / BYOK / fallback) over raw provider id. */
  category?: ModelCategory
  assignment?: CategoryAssignment
}

async function pickProvider(
  deps: ClientDeps | undefined,
  providerId: string,
  model?: string
): Promise<LlmProvider> {
  if (deps?.provider) return deps.provider
  if (deps?.category) {
    const res = await resolveCategoryProvider(deps.category, deps.assignment)
    if (res.provider) return res.provider
    throw new Error(res.error || `No usable ${deps.category} model`)
  }
  return deps?.provider ?? (await resolveClientProvider(providerId, model))
}

// Extraction pass: raw speech window -> typed pending signals. A transport
// failure yields skipped=true (engine puts the raw back and retries); a parsed
// empty list means "discard this window".
export async function requestExtractSignals(
  req: ExtractSignalsRequest,
  deps?: ClientDeps
): Promise<ExtractSignalsResult> {
  try {
    const provider = await pickProvider(deps, req.provider, req.model)
    if (!isProviderUsable(provider)) {
      return {
        signals: [],
        skipped: true,
        serverMs: 0,
        error: `Listener model "${provider.id}" has no API key. Add one in Settings.`
      }
    }
    const out = await extractSignals(
      provider,
      { systemPrompt: req.systemPrompt, rawText: req.rawText, existingSignals: req.existingSignals },
      deps?.fetchImpl
    )
    return { signals: out.signals, skipped: out.skipped, serverMs: out.serverMs, model: out.model, error: out.error }
  } catch (e: any) {
    return { signals: [], skipped: true, serverMs: 0, error: e?.message || String(e) }
  }
}

// Organize pass: pending signals -> titled sections. On any failure it returns
// empty sections so the engine treats the round as "no organize".
export async function requestOrganize(req: OrganizeRequest, deps?: ClientDeps): Promise<OrganizeResult> {
  try {
    const provider = await pickProvider(deps, req.provider, req.model)
    const out = await organize(provider, { lines: req.lines, closing: req.closing }, deps?.fetchImpl)
    return { sections: out.sections, serverMs: out.serverMs, model: out.model, error: out.error }
  } catch (e: any) {
    return { sections: [], serverMs: 0, error: e?.message || String(e) }
  }
}

// Summarize a finished section's body into a short header.
export async function requestSectionHeader(
  req: SectionHeaderRequest,
  deps?: ClientDeps
): Promise<SectionHeaderResult> {
  try {
    const provider = await pickProvider(deps, req.provider, req.model)
    const out = await sectionHeader(provider, req.body, deps?.fetchImpl)
    return { header: out.header, serverMs: out.serverMs, model: out.model, error: out.error }
  } catch (e: any) {
    return { header: '', serverMs: 0, error: e?.message || String(e) }
  }
}
