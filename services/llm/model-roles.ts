// Two-category model resolution (observer feature, contract §2.6 / §4).
//
// The app exposes exactly two user-facing model choices — Listener (speech-side,
// speed-valued) and Thinker (content-side, quality-valued). This module turns a
// category + the user's assignment for it into a callable resolution, applying
// the fallback ladder so nothing ever fails silently:
//
//   1. the category's user-assigned model, when usable (BYOK / CLI);
//   2. else hosted DeepSeek Flash/Pro when signed into the Go backend;
//   3. else DEFAULT_BASE_MODEL (Groq) for local-only / BYOK fallback;
//   4. else { error }.

import { isProviderUsable, type LlmProvider } from '../../packages/core/llm'
import type { ModelCategory } from '../../packages/core/llm/observer-types'
import { resolveClientProvider } from './provider-config'
import type { LocalRuntime } from './local-runtime'
import { hostedProviderFor } from './llm-transport'

/** Local-only / BYOK fallback when hosted LLM is unavailable. */
export const DEFAULT_BASE_MODEL = { providerId: 'groq', model: 'openai/gpt-oss-120b' } as const

/** Runtime kinds a category assignment can carry (mirrors AiModelConfig.runtime). */
export type CategoryRuntime = 'api' | 'ollama' | 'codex' | 'claude-code' | 'cursor'

/** The user's model choice for a category, derived from the selected AiModelConfig. */
export interface CategoryAssignment {
  runtime: CategoryRuntime
  providerId?: string
  model?: string
  /** Non-empty when the user supplied their own MaaS key (BYOK override). */
  apiKey?: string
  /** CLI runtime command override (Thinker only). */
  command?: string
}

/** Resolved category: exactly one of `provider` (web) / `runtime` (CLI) / `error`. */
export interface CategoryResolution {
  /** Web-provider path (api / ollama / hosted). */
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
  /** Test seam. Defaults to hostedProviderFor from llm-transport. */
  hostedProvider?: (category: ModelCategory) => LlmProvider | null
}

const CLI_RUNTIMES = ['codex', 'claude-code', 'cursor'] as const
function isCliRuntime(r: CategoryRuntime): r is LocalRuntime {
  return (CLI_RUNTIMES as readonly string[]).includes(r)
}

function hasByokKey(assigned?: CategoryAssignment): boolean {
  return !!(assigned?.apiKey && assigned.apiKey.trim())
}

export async function resolveCategoryProvider(
  category: ModelCategory,
  assigned?: CategoryAssignment,
  deps?: ModelRolesDeps
): Promise<CategoryResolution> {
  const resolveProvider = deps?.resolveProvider ?? resolveClientProvider
  const hosted = deps?.hostedProvider ?? hostedProviderFor

  // 1. Explicit BYOK / CLI assignment.
  if (assigned) {
    if (isCliRuntime(assigned.runtime)) {
      // Listener never runs on a CLI runtime — fall through.
      if (category === 'thinker') {
        return { runtime: assigned.runtime, command: assigned.command, model: assigned.model }
      }
    } else if (hasByokKey(assigned) || assigned.runtime === 'ollama') {
      const providerId = assigned.runtime === 'ollama' ? 'ollama' : assigned.providerId || 'groq'
      const provider = await resolveProvider(providerId, assigned.model)
      if (isProviderUsable(provider)) return { provider }
    }
  }

  // 2. Hosted DeepSeek when signed in (no personal key required).
  const hostedProvider = hosted(category)
  if (hostedProvider && isProviderUsable(hostedProvider)) {
    return { provider: hostedProvider }
  }

  // 3. Local Groq fallback (local-only / leftover keys in provider-config).
  const fallback = await resolveProvider(DEFAULT_BASE_MODEL.providerId, DEFAULT_BASE_MODEL.model)
  if (isProviderUsable(fallback)) return { provider: fallback }

  // 4. Nothing usable.
  return {
    error: `No usable ${category} model. Sign in for hosted DeepSeek, or assign a model with an API key in Settings.`
  }
}
