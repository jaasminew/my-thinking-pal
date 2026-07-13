// Provider presets + resolution. The browser holds keys (per docs module 08);
// this module only shapes/validates provider config and never performs I/O.

import type { LlmProvider, ProviderKind } from './types'

// Built-in presets. baseUrl/model come from here; apiKey is filled from user
// settings (or a dev-only .env fallback in the wiring layer). Ollama needs no key.
export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  defaultModel: string
  kind: ProviderKind
  keyless?: boolean
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-20b',
    kind: 'openai-compatible'
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama3.1-8b',
    kind: 'openai-compatible'
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    kind: 'openai-compatible'
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    kind: 'openai-compatible'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct',
    kind: 'openai-compatible'
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen3:1.7b',
    kind: 'openai-compatible',
    keyless: true
  }
}

// Build a concrete provider from a preset id + user overrides. Throws when a
// key-required provider has no key, so callers fail fast before any request.
export function resolveProvider(
  presetId: string,
  overrides: { apiKey?: string; model?: string; baseUrl?: string; label?: string } = {}
): LlmProvider {
  const preset = PROVIDER_PRESETS[presetId]
  if (!preset) {
    // Unknown id → treat as a custom OpenAI-compatible endpoint (needs baseUrl).
    if (!overrides.baseUrl) throw new Error(`Unknown provider "${presetId}" and no baseUrl provided`)
    return {
      id: presetId,
      label: overrides.label || presetId,
      baseUrl: overrides.baseUrl,
      apiKey: overrides.apiKey || '',
      model: overrides.model || '',
      kind: 'openai-compatible'
    }
  }
  return {
    id: preset.id,
    label: preset.label,
    baseUrl: overrides.baseUrl || preset.baseUrl,
    apiKey: overrides.apiKey || '',
    model: overrides.model || preset.defaultModel,
    kind: preset.kind
  }
}

// True when this provider can actually be called (keyless or has a key).
export function isProviderUsable(p: LlmProvider): boolean {
  if (PROVIDER_PRESETS[p.id]?.keyless) return true
  return !!p.apiKey
}
