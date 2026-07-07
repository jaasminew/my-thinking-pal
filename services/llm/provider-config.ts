// Browser-side LLM settings + key source. This is the only place that touches
// localStorage / a dev endpoint; the resolution logic itself lives in the pure,
// tested packages/core/settings module.
//
// Key story (docs module 08): the browser holds the key. Users enter it in the
// settings UI (persisted to localStorage). For local `npm run dev` convenience a
// dev-only compile-time inject (services/dev-keys.ts) fills in the .env keys —
// it is `null` in a static production build, so the fallback silently no-ops.

import {
  DEFAULT_LLM_SETTINGS,
  resolveFromSettings,
  type LlmSettings,
  type StoredProvider
} from '../../packages/core/settings/llm-settings'
import { isProviderUsable, type LlmProvider } from '../../packages/core/llm'
import { devKeys } from '../dev-keys'

const LS_KEY = 'thinking-pal.llm-settings'

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

function loadSettings(): LlmSettings {
  if (!hasLocalStorage()) return structuredCloneSettings(DEFAULT_LLM_SETTINGS)
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return { ...DEFAULT_LLM_SETTINGS, ...(JSON.parse(raw) as Partial<LlmSettings>) } as LlmSettings
  } catch {
    /* corrupt / disabled storage — fall through to defaults */
  }
  return structuredCloneSettings(DEFAULT_LLM_SETTINGS)
}

function structuredCloneSettings(s: LlmSettings): LlmSettings {
  return { ...s, providers: { ...s.providers }, webSearch: s.webSearch ? { ...s.webSearch } : undefined }
}

let current: LlmSettings = loadSettings()

export function getSettings(): LlmSettings {
  return current
}

export function saveSettings(next: LlmSettings): void {
  current = next
  if (!hasLocalStorage()) return
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next))
  } catch {
    /* quota / disabled — settings still live in-memory this session */
  }
}

// Desktop (Electron) exposes an OS-keychain-backed store via preload
// (docs module 11.3). On the web this is undefined and every path below no-ops.
interface SecureKeyStore {
  get(id: string): Promise<string | null>
  set(id: string, value: string): Promise<boolean>
  list(): Promise<string[]>
}
function secureStore(): SecureKeyStore | undefined {
  return (globalThis as unknown as { secureKeys?: SecureKeyStore }).secureKeys
}
const secureKeyId = (providerId: string) => `llm.${providerId}`

export function setProviderConfig(id: string, cfg: StoredProvider): void {
  saveSettings({ ...current, providers: { ...current.providers, [id]: { ...current.providers[id], ...cfg } } })
  // On desktop, mirror the key into the OS keychain (best effort) so it isn't
  // only living in localStorage.
  const ss = secureStore()
  if (ss && cfg.apiKey) void ss.set(secureKeyId(id), cfg.apiKey).catch(() => {})
}

export function setActiveProvider(id: string): void {
  saveSettings({ ...current, activeProviderId: id })
}

// Dev-only fallback: fill in providers the user hasn't configured from the
// compile-time .env inject (null in a static prod build → no-op). Runs once.
let devApplied = false
function applyDevKeys(): void {
  if (devApplied) return
  devApplied = true
  const dev = devKeys()
  if (!dev) return
  const providers = { ...current.providers }
  for (const id of ['groq', 'cerebras', 'ollama'] as const) {
    const v = dev[id]
    if (!v) continue
    const existing = providers[id] ?? {}
    providers[id] = {
      apiKey: existing.apiKey || v.key || '',
      model: existing.model || v.model,
      baseUrl: existing.baseUrl || (v as { baseUrl?: string }).baseUrl
    }
  }
  current = { ...current, providers }
}

// Desktop-only: hydrate empty provider keys from the OS keychain once.
let secureKeysPromise: Promise<void> | undefined
async function ensureSecureKeys(): Promise<void> {
  const ss = secureStore()
  if (!ss) return
  if (!secureKeysPromise) {
    secureKeysPromise = (async () => {
      const providers = { ...current.providers }
      let changed = false
      for (const id of Object.keys(providers)) {
        if (providers[id]?.apiKey) continue
        try {
          const k = await ss.get(secureKeyId(id))
          if (k) {
            providers[id] = { ...providers[id], apiKey: k }
            changed = true
          }
        } catch {
          /* keychain unavailable — ignore */
        }
      }
      if (changed) current = { ...current, providers }
    })()
  }
  return secureKeysPromise
}

// Resolve a callable provider for a request. Tries user settings first, then the
// desktop keychain, then the dev key fallback if the provider isn't usable yet.
export async function resolveClientProvider(providerId?: string, model?: string): Promise<LlmProvider> {
  let provider = resolveFromSettings(current, { providerId, model })
  if (!isProviderUsable(provider)) {
    await ensureSecureKeys()
    provider = resolveFromSettings(current, { providerId, model })
  }
  if (!isProviderUsable(provider)) {
    applyDevKeys()
    provider = resolveFromSettings(current, { providerId, model })
  }
  return provider
}
