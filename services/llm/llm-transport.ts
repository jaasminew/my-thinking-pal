// Hosted LLM transport: when signed into the Go backend without a personal
// (BYOK) key, chat/stream calls go to POST /llm/chat/completions with JWT +
// X-Thinking-Pal-Role. Listener → DeepSeek Flash, Thinker → DeepSeek Pro.

import type { LlmProvider } from '../../packages/core/llm'
import type { ModelCategory } from '../../packages/core/llm/observer-types'
import { apiBaseUrl, apiEnabled } from '../api/config'
import { sharedTokenStore } from '../api/tokens'

export const HOSTED_LISTENER_MODEL = 'deepseek-v4-flash'
export const HOSTED_THINKER_MODEL = 'deepseek-v4-pro'
export const ROLE_HEADER = 'X-Thinking-Pal-Role'

export type LlmTransportMode = 'client' | 'hosted'

export type LlmTransportConfig = {
  mode: LlmTransportMode
  /** Access-token getter for hosted mode (defaults to sharedTokenStore). */
  getToken?: () => string | null
  /** API origin for hosted mode (defaults to apiBaseUrl()). */
  apiBase?: string
}

let config: LlmTransportConfig = { mode: 'client' }

/** App wires this when backend auth state changes. */
export function configureLlmTransport(next: LlmTransportConfig): void {
  config = next
}

export function llmTransportMode(): LlmTransportMode {
  return config.mode
}

export function hostedLlmAvailable(): boolean {
  // Explicit apiBase (tests / custom wiring) counts even when VITE_API_URL is empty.
  if (config.mode !== 'hosted') return false
  return apiEnabled() || !!(config.apiBase && config.apiBase.trim())
}

function token(): string | null {
  return (config.getToken ?? (() => sharedTokenStore().access))()
}

function apiBase(): string {
  return (config.apiBase ?? apiBaseUrl()).replace(/\/+$/, '')
}

/** Hosted DeepSeek provider for a category. apiKey is the JWT access token. */
export function hostedProviderFor(category: ModelCategory): LlmProvider | null {
  if (!hostedLlmAvailable()) return null
  const access = token()
  if (!access) return null
  const listener = category === 'listener'
  return {
    id: 'hosted-deepseek',
    label: listener ? 'Hosted DeepSeek Flash' : 'Hosted DeepSeek Pro',
    baseUrl: `${apiBase()}/llm`,
    apiKey: access,
    model: listener ? HOSTED_LISTENER_MODEL : HOSTED_THINKER_MODEL,
    kind: 'openai-compatible',
    requestHeaders: { [ROLE_HEADER]: category }
  }
}
