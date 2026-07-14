// Persistence-agnostic append-only log for observer events.
//
// `load`/`save` are injected so the Lead can wire this to localStorage, Yjs,
// or any other store. The log keeps at most `OBSERVER_LOG_CAP` records,
// dropping the oldest first when the cap is exceeded. `load` runs once at
// construction; every `append` persists the full (capped) array via `save`.
//
// Ring buffer for observer debug events (cap 500).

import type { ObserverLogRecord } from '../../../packages/core/llm/observer-types'

export const OBSERVER_LOG_CAP = 500

/**
 * Create a capped append-only log backed by injected persistence.
 * `load` is called once at construction; every `append` saves the full
 * (capped) array via `save`. Oldest records drop first. `all()` returns
 * a copy so callers cannot mutate internal state.
 */
export function makeObserverLog(
  load: () => ObserverLogRecord[],
  save: (records: ObserverLogRecord[]) => void,
  cap?: number
): {
  append(r: ObserverLogRecord): void
  all(): ObserverLogRecord[]
} {
  const maxCap = cap ?? OBSERVER_LOG_CAP
  let records: ObserverLogRecord[] = load()

  return {
    append(r: ObserverLogRecord): void {
      records = [...records, { ...r }]
      if (records.length > maxCap) {
        records = records.slice(records.length - maxCap)
      }
      save(records)
    },
    all(): ObserverLogRecord[] {
      return records.map((r) => ({ ...r }))
    }
  }
}
