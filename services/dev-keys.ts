// Dev-only key inject. Replaces the old runtime `/api/llm-config` and
// `/api/soniox-key` handoffs (retired): Vite's `define` swaps `__DEV_LLM_KEYS__`
// for the `.env` values during `npm run dev`, and for `null` in production
// builds and under test. This lets local dev skip in-app key entry with NO
// runtime endpoint. In prod the browser holds user-entered keys (LLM settings
// UI) or, on desktop, the OS keychain — see docs modules 08 / 11.
export interface DevLlmKeys {
  groq?: { key?: string; model?: string }
  cerebras?: { key?: string; model?: string }
  ollama?: { key?: string; model?: string; baseUrl?: string }
  soniox?: { key?: string; model?: string }
}

declare const __DEV_LLM_KEYS__: DevLlmKeys | null | undefined

export function devKeys(): DevLlmKeys | null {
  // `typeof` guard first: safe even when the token was never defined (e.g. a
  // bundler without our `define`), where a bare reference would ReferenceError.
  if (typeof __DEV_LLM_KEYS__ === 'undefined' || !__DEV_LLM_KEYS__) return null
  return __DEV_LLM_KEYS__
}
