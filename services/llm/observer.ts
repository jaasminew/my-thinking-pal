// Observer services wiring: resolve the two model categories, run the
// evaluator/contributor passes, execute the search path, and assemble the
// ObserverContributionResult the engine emits. This is the observer's analogue
// of cocreate.ts — the App builds the engine's evaluate/contribute deps from the
// two functions below, injecting per-category assignments and (in tests) mock
// passes / search.
//
// Split of responsibility with the engine (contract §3):
//  - The engine owns gates, cooldown, dedup, staleness — pure of I/O.
//  - This module owns provider resolution + the LLM/search I/O.
//  - `listener-unavailable` is NOT decided here: the App pre-flights the Listener
//    category at setup (via resolveCategoryProvider) to show the visible notice
//    and skip starting the engine. Mid-session, if resolution fails, evaluate
//    returns null and the engine logs an ordinary error.

import type { FetchLike, UrlCard } from '../../packages/core/llm'
import {
  buildObserverContributorSystem,
  buildObserverContributorUserText
} from '../../packages/core/llm/observer-prompts'
import { parseObserverContribution } from '../../packages/core/llm/observer-parse'
import { observerContribute, observerEvaluate } from '../../packages/core/llm/observer-passes'
import type {
  ObserverContributionResult,
  ObserverContributorInput,
  ObserverDecision,
  ObserverEvaluationFailure,
  ObserverEvaluatorInput
} from '../../packages/core/llm/observer-types'
import {
  resolveCategoryProvider,
  type CategoryAssignment,
  type CategoryResolution
} from './model-roles'
import { resolveSearchPath } from './observer-search'
import { runLocalPrompt } from './local-runtime'
import { searchWeb } from './web-search'

/** Cap on source cards attached to one observer note (contract §4). */
export const MAX_SOURCE_CARDS = 3

export interface ObserverServiceDeps {
  /** Listener-category assignment (App derives from the selected AiModelConfig). */
  listener?: CategoryAssignment
  /** Thinker-category assignment. */
  thinker?: CategoryAssignment
  /** Whether the /api/search relay is configured (drives the web search path). */
  relayAvailable?: boolean
  fetchImpl?: FetchLike
  // ---- test seams (all default to the real implementations) ----
  resolveCategory?: (category: 'listener' | 'thinker', assigned?: CategoryAssignment) => Promise<CategoryResolution>
  evaluatePass?: typeof observerEvaluate
  contributePass?: typeof observerContribute
  runLocalPromptImpl?: typeof runLocalPrompt
  searchWebImpl?: typeof searchWeb
}

/**
 * Resolve the Listener category and run the evaluator. Failures retain a
 * machine-readable reason so the engine log identifies resolution, transport,
 * and parse failures instead of collapsing all three to a bare null.
 */
export async function requestObserverEvaluate(
  input: ObserverEvaluatorInput,
  deps: ObserverServiceDeps
): Promise<ObserverDecision | ObserverEvaluationFailure> {
  const resolve = deps.resolveCategory ?? resolveCategoryProvider
  const res = await resolve('listener', deps.listener)
  // Listener is web-only; a resolution without a provider (or with an error)
  // cannot evaluate. Setup-time pre-flight already surfaced the notice.
  if (res.error || !res.provider) {
    return { decision: null, error: `listener-unresolved: ${res.error || 'no provider returned'}` }
  }
  const pass = deps.evaluatePass ?? observerEvaluate
  const out = await pass(res.provider, input, deps.fetchImpl)
  if (out.decision) return out.decision
  return {
    decision: null,
    error: out.error || 'unparseable-response',
    ...(out.model ? { model: out.model } : {})
  }
}

/**
 * Resolve the Thinker category, run the contributor, execute the search path,
 * and assemble the result. Web Thinkers emit a `SEARCH:` line relayed through
 * searchWeb; CLI Thinkers search natively (their transport already ran search,
 * so no relay call). Returns null when the Thinker is unusable or the pass
 * failed. Search failure yields empty `sources`, never fabricated URLs.
 */
export async function requestObserverContribute(
  input: ObserverContributorInput,
  deps: ObserverServiceDeps
): Promise<ObserverContributionResult | null> {
  const resolve = deps.resolveCategory ?? resolveCategoryProvider
  const res = await resolve('thinker', deps.thinker)
  if (res.error) return contributionFailure(`thinker-unresolved: ${res.error}`)

  // ---- CLI runtime: run once via local-runtime, parse the collected output.
  if (res.runtime) {
    const text = await runCliContributor(res, input, deps)
    if (text == null) return contributionFailure('local-runtime-failed', res.model, 'cli-native')
    const contribution = parseObserverContribution(text)
    if (!contribution) return contributionFailure('unparseable-response', res.model, 'cli-native')
    // The frozen contributor protocol (contract §1.2) carries no source URLs, so
    // a CLI-native contribution surfaces no cards in the MVP — its native search
    // informs the bullets but is not extracted (see contract §5 clarification).
    return {
      keyword: contribution.keyword,
      bullets: contribution.bullets,
      sources: [],
      searchPath: 'cli-native',
      model: res.model
    }
  }

  // ---- Web provider: run the pass, then relay the SEARCH: query if configured.
  if (!res.provider) return contributionFailure('thinker-unresolved: no provider returned')
  const pass = deps.contributePass ?? observerContribute
  const out = await pass(res.provider, input, deps.fetchImpl)
  const searchPath = resolveSearchPath(res.provider.id, deps.relayAvailable ?? false)
  if (!out.contribution) {
    return contributionFailure(out.error || 'unparseable-response', out.model, searchPath)
  }
  const contribution = out.contribution

  // Prefer the contributor's own SEARCH: query, but fall back to the evaluator's
  // suggestedSearchQuery when the contributor omits it (it often does). The
  // evaluator already committed to needsResearch, so a missing contributor
  // SEARCH line must not silently drop the source cards.
  const searchQuery =
    contribution.searchQuery ||
    (input.decision.needsResearch ? input.decision.suggestedSearchQuery : undefined)
  let sources: UrlCard[] = []
  if (searchPath === 'relay' && searchQuery) {
    const doSearch = deps.searchWebImpl ?? searchWeb
    try {
      const raw = await doSearch(searchQuery, MAX_SOURCE_CARDS, deps.fetchImpl as typeof fetch)
      sources = validCards(raw)
    } catch {
      // Search failure → no sources; never fabricate. The bullets stand alone.
      sources = []
    }
  }

  return {
    keyword: contribution.keyword,
    bullets: contribution.bullets,
    sources,
    searchPath,
    model: out.model
  }
}

function contributionFailure(
  error: string,
  model?: string,
  searchPath: ObserverContributionResult['searchPath'] = 'none'
): ObserverContributionResult {
  return {
    keyword: '',
    bullets: [],
    sources: [],
    searchPath,
    error: `contributor: ${error}`,
    ...(model ? { model } : {})
  }
}

// Run the contributor prompt on a CLI runtime, collecting the whole output.
// Returns null on transport failure (engine logs an error round).
async function runCliContributor(
  res: CategoryResolution,
  input: ObserverContributorInput,
  deps: ObserverServiceDeps
): Promise<string | null> {
  const run = deps.runLocalPromptImpl ?? runLocalPrompt
  try {
    return await run(
      {
        runtime: res.runtime!,
        command: res.command,
        model: res.model,
        system: buildObserverContributorSystem(),
        userText: buildObserverContributorUserText(input)
      },
      deps.fetchImpl as typeof fetch
    )
  } catch {
    return null
  }
}

// Keep only well-formed http(s) URLs, capped at MAX_SOURCE_CARDS. The engine
// still dedups these against URLs already on the canvas.
function validCards(cards: UrlCard[]): UrlCard[] {
  const out: UrlCard[] = []
  for (const c of Array.isArray(cards) ? cards : []) {
    if (out.length >= MAX_SOURCE_CARDS) break
    if (c && typeof c.url === 'string' && isHttpUrl(c.url)) out.push(c)
  }
  return out
}

function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
