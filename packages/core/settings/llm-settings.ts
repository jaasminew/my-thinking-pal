// Pure settings model + provider resolution. Framework-agnostic (no localStorage
// / fetch here) so it is exhaustively testable; the browser I/O layer lives in
// services/llm/provider-config.ts and feeds keys into resolveFromSettings().

import { PROVIDER_PRESETS, resolveProvider } from '../llm/providers'
import type { LlmProvider } from '../llm/types'

export interface StoredProvider {
  apiKey?: string
  model?: string
  baseUrl?: string
}

export interface LlmSettings {
  // Which OpenAI-compatible provider the client talks to by default.
  activeProviderId: string
  // Per-provider overrides (key/model/baseUrl). Keys never leave the client.
  providers: Record<string, StoredProvider>
  webSearch?: {
    enabled: boolean
    provider?: 'tavily' | 'exa' | 'brave'
    apiKey?: string
  }
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  activeProviderId: 'groq',
  providers: {},
  webSearch: { enabled: false }
}

// The retired CLI backends (and the legacy 'open' umbrella) can't run in a
// browser — map them onto a concrete OpenAI-compatible preset. A caller-supplied
// preset id is honored as-is when it's real.
export function normalizeProviderId(id: string | undefined, settings: LlmSettings): string {
  if (id && PROVIDER_PRESETS[id]) return id
  // id is undefined, an alias ('open'), or a CLI ('codex'/'claude-code').
  if (PROVIDER_PRESETS[settings.activeProviderId]) return settings.activeProviderId
  return 'groq'
}

// Resolve a concrete, callable LlmProvider from settings. `providerId`/`model`
// are optional per-call overrides (e.g. the engine's extractModel picker).
export function resolveFromSettings(
  settings: LlmSettings,
  opts?: { providerId?: string; model?: string }
): LlmProvider {
  const id = normalizeProviderId(opts?.providerId, settings)
  const stored = settings.providers[id] ?? {}
  return resolveProvider(id, {
    apiKey: stored.apiKey,
    model: opts?.model || stored.model,
    baseUrl: stored.baseUrl
  })
}
