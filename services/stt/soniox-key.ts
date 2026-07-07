// Soniox key source for the browser-direct STT path (SonioxSTT).
//
// When signed in the app uses the backend `/stt` proxy (BackendSTT) and never
// touches this. Browser-direct Soniox is the LOCAL fallback; its key comes from
// the dev-only compile-time inject (see services/dev-keys.ts), which is `null`
// in a production build — so this resolver degrades to an empty key instead of
// throwing, and the caller surfaces a clear "sign in / add key" message.

import { devKeys, type DevLlmKeys } from '../dev-keys'

export interface SonioxKey {
  key: string
  model: string
}

const DEFAULT_MODEL = 'stt-rt-v5'

export function devSonioxKey(source: DevLlmKeys | null = devKeys()): SonioxKey {
  const s = source?.soniox
  return { key: s?.key ?? '', model: s?.model || DEFAULT_MODEL }
}
