// Two-category model resolution (observer feature, contract §2.6 / §4).
//
// The app exposes exactly two user-facing model choices — Listener (speech-side,
// speed-valued) and Thinker (content-side, quality-valued). This module turns a
// category + the user's assignment for it into a callable resolution, applying
// the fallback ladder so nothing ever fails silently:
//
//   1. the category's user-assigned model, when usable (Listener rejects CLI
//      runtimes outright — the ambient evaluator can't afford CLI startup);
//   2. else DEFAULT_BASE_MODEL (Groq gpt-oss-120b);
//   3. else { error } — the caller shows a VISIBLE notice and disables the
//      dependent feature.
//
// The resolver is injectable (ModelRolesDeps.resolveProvider) so it is testable
// without the provider-config localStorage singleton, matching the CocreateDeps
// seam in cocreate.ts.

import { isProviderUsable, type LlmProvider } from '../../packages/core/llm'
import type { ModelCategory } from '../../packages/core/llm/observer-types'
import { resolveClientProvider } from './provider-config'
import type { LocalRuntime } from './local-runtime'

/** The switchable default both categories fall back to (contract §4). */
export const DEFAULT_BASE_MODEL = { providerId: 'groq', model: 'openai/gpt-oss-120b' } as const

/** Runtime kinds a category assignment can carry (mirrors AiModelConfig.runtime). */
export type CategoryRuntime = 'api' | 'ollama' | 'codex' | 'claude-code' | 'cursor'

/** The user's model choice for a category, derived from the selected AiModelConfig. */
export interface CategoryAssignment {
  runtime: CategoryRuntime
  providerId?: string
  model?: string
  /** CLI runtime command override (Thinker only). */
  command?: string
}

/** Resolved category: exactly one of `provider` (web) / `runtime` (CLI) / `error`. */
export interface CategoryResolution {
  /** Web-provider path (api / ollama). */
  provider?: LlmProvider
  /** CLI path — Thinker only; carries the transport args for local-runtime. */
  runtime?: LocalRuntime
  command?: string
  model?: string
  /** Nothing usable — the caller shows a visible notice. */
  error?: string
}

export interface ModelRolesDeps {
  /** Test seam. Defaults to the provider-config localStorage resolver. */
  resolveProvider?: (providerId?: string, model?: string) => Promise<LlmProvider>
}

const CLI_RUNTIMES = ['codex', 'claude-code', 'cursor'] as const
function isCliRuntime(r: CategoryRuntime): r is LocalRuntime {
  return (CLI_RUNTIMES as readonly string[]).includes(r)
}

export async function resolveCategoryProvider(
  category: ModelCategory,
  assigned?: CategoryAssignment,
  deps?: ModelRolesDeps
): Promise<CategoryResolution> {
  const resolveProvider = deps?.resolveProvider ?? resolveClientProvider

  // 1. The user's assigned model, when the category allows it.
  if (assigned) {
    if (isCliRuntime(assigned.runtime)) {
      // Listener never runs on a CLI runtime — fall through to the default.
      if (category === 'thinker') {
        return { runtime: assigned.runtime, command: assigned.command, model: assigned.model }
      }
    } else {
      const providerId = assigned.runtime === 'ollama' ? 'ollama' : assigned.providerId || 'groq'
      const provider = await resolveProvider(providerId, assigned.model)
      if (isProviderUsable(provider)) return { provider }
    }
  }

  // 2. Fallback ladder: DEFAULT_BASE_MODEL on Groq.
  const fallback = await resolveProvider(DEFAULT_BASE_MODEL.providerId, DEFAULT_BASE_MODEL.model)
  if (isProviderUsable(fallback)) return { provider: fallback }

  // 3. Nothing usable — the caller surfaces a visible notice + a log record.
  return { error: `No usable ${category} model. Assign one in Settings or configure a Groq API key.` }
}
