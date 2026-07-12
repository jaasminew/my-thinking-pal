// Search-path resolution for the observer contributor.
//
// Pure mapping from the resolved Thinker-category provider id + relay
// availability to a SearchPath. No config import, no network, no side effects.
// See docs/observer/contract.md §2.2.

import type { SearchPath } from '../../packages/core/llm/observer-types'

// The three CLI runtime ids whose own transport performs native search.
const CLI_RUNTIME_IDS = new Set(['codex', 'claude-code', 'cursor'])

/**
 * providerId: resolved provider id (after 'open' → openSub mapping).
 * 'codex' | 'claude-code' | 'cursor' → 'cli-native'.
 * Otherwise 'relay' when relayAvailable, else 'none'.
 */
export function resolveSearchPath(providerId: string, relayAvailable: boolean): SearchPath {
  if (CLI_RUNTIME_IDS.has(providerId)) return 'cli-native'
  return relayAvailable ? 'relay' : 'none'
}
