# Observer Feature — Frozen Contracts

Companion to `packages/core/llm/observer-types.ts` (marked `CONTRACTS FROZEN`).
That file is the source of truth for everything the type system can express;
this file freezes everything it can't: wire formats, function signatures per
module, gate semantics, and constants. Both together are the single binding
specification for every observer task.

If something you need isn't covered here or in the types file, that is a gap
in the contract — **stop and ask the Lead**, do not infer or invent.

---

## 1. Wire formats

### 1.1 Evaluator output (model → parser)

The evaluator model must return exactly one JSON object (it may be wrapped in
markdown fences or surrounded by prose; the parser extracts the first
balanced `{...}` block):

```json
{
  "emit": true,
  "confidence": 0.8,
  "opportunityType": "risk",
  "topic": "conflict resolution strategy",
  "reason": "the group compared databases but never discussed sync conflicts",
  "needsResearch": false,
  "suggestedSearchQuery": null
}
```

Parse rules (`parseObserverDecision`):

- Missing/non-boolean `emit` → **malformed → return `null`**.
- `confidence` non-numeric or absent → default `0`.
- When `emit` is `true`: `opportunityType` must be one of the seven
  `ObserverOpportunityType` values and `topic` must be a non-empty string —
  otherwise malformed → `null`.
- When `emit` is `false`: all other fields optional; return
  `{ emit: false, confidence }`.
- `needsResearch` defaults `false`; `suggestedSearchQuery` only kept when it
  is a non-empty string.
- Never throw. Any unparseable input → `null`.

### 1.2 Contributor output (model → parser)

Plain text protocol:

```
KEYWORD: Offline synchronization
- Conflict resolution is a separate decision from database selection.
- Compare last-write-wins, field-level merge, and CRDT approaches.
- Yjs is relevant because the current canvas already uses a CRDT.
SEARCH: yjs crdt conflict resolution
```

Parse rules (`parseObserverContribution`):

- `KEYWORD:` line required (case-insensitive match, trim value). Missing or
  empty → malformed → `null`.
- Bullets: lines starting with `-` or `*` (trimmed). Keep at most **3**; zero
  bullets → malformed → `null`.
- `SEARCH:` line optional, case-insensitive, anywhere after KEYWORD; first
  occurrence wins; empty query ignored.
- All other lines ignored. Never throw; unparseable → `null`.

---

## 2. Module signatures

Written as real signatures; implement exactly.

### 2.1 `packages/core/llm/observer-parse.ts` (Implementer, I1)

```ts
import type { ObserverDecision, ObserverContribution } from './observer-types'

export function parseObserverDecision(content: string): ObserverDecision | null
export function parseObserverContribution(content: string): ObserverContribution | null
```

### 2.2 `services/llm/observer-search.ts` (Implementer, I2)

```ts
import type { SearchPath } from '../../packages/core/llm/observer-types'

/**
 * providerId: resolved provider id (after 'open' → openSub mapping).
 * 'codex' | 'claude-code' | 'cursor' → 'cli-native'.
 * Otherwise 'relay' when relayAvailable, else 'none'.
 */
export function resolveSearchPath(providerId: string, relayAvailable: boolean): SearchPath
```

### 2.3 `apps/web/src/observer-engine.ts` (Implementer, I3)

```ts
import type {
  ObserverEngineDeps, ObserverEngineConfig, ObserverState, ObserverSignal,
  ObserverEmission, ObserverLogRecord, ObserverOutcome
} from '../../../packages/core/llm/observer-types'

export class ObserverEngine {
  constructor(deps: ObserverEngineDeps, config: ObserverEngineConfig, initialState?: ObserverState)
  /** Approved contribution ready for the canvas (Lead converts it to a note). */
  onEmit: (e: ObserverEmission) => void
  /** Every evaluation, emission, skip, and error — the day-one log. */
  onLog: (r: ObserverLogRecord) => void
  start(): void
  stop(): void
  /** Canvas switch: bump generation, clear volatile progress, drop late results. */
  reset(): void
  setEnabled(enabled: boolean): void
  /** Called with each fresh SignalEngine batch; runs the gate → evaluate → contribute cycle. */
  pushSignals(lines: ObserverSignal[]): void
  /** Keep/reject/post-session-ignore feedback (drives rejection backoff). */
  recordOutcome(outcome: ObserverOutcome): void
  getState(): ObserverState
}
```

### 2.4 `apps/web/src/observer-placement.ts` (Implementer, I4)

```ts
export interface PlacedRect { x: number; y: number; w: number; h: number }

/**
 * Deterministic, collision-safe position for a new observer note.
 * Assume the new note is DEFAULT_NOTE_W x DEFAULT_NOTE_H. Try candidate
 * positions in an expanding clockwise ring around `anchor` (step
 * PLACEMENT_STEP, starting right of the anchor); return the first whose
 * rect overlaps no existing rect (with PLACEMENT_MARGIN padding). If none
 * within PLACEMENT_MAX_RING rings, place below the bottom-most existing
 * rect, left-aligned to anchor.x.
 */
export function placeObserverNote(
  existing: PlacedRect[],
  anchor: { x: number; y: number }
): { x: number; y: number }
```

### 2.5 `apps/web/src/observer-log.ts` (Implementer, I5)

```ts
import type { ObserverLogRecord } from '../../../packages/core/llm/observer-types'

/**
 * Persistence-agnostic append log. `load`/`save` are injected (the Lead wires
 * them to the app's loadJSON/saveJSON with a per-space key). Keeps at most
 * `cap` records (drop oldest).
 */
export function makeObserverLog(
  load: () => ObserverLogRecord[],
  save: (records: ObserverLogRecord[]) => void,
  cap?: number
): {
  append(r: ObserverLogRecord): void
  all(): ObserverLogRecord[]
}
```

### 2.6 Lead-owned modules (context only — Implementer never touches)

```ts
// services/llm/model-roles.ts — the two-category model resolver (Lead, L0).
// 'listener' resolution rejects CLI runtimes; 'thinker' accepts them.
// Fallback ladder: category's user-assigned model if usable → DEFAULT_BASE_MODEL
// (Groq gpt-oss-120b) → { error } when the Groq key is also missing (callers
// surface a VISIBLE notice; nothing fails silently).
export interface CategoryResolution {
  provider?: LlmProvider          // web-provider path
  runtime?: LocalRuntime          // CLI path (thinker only)
  command?: string                // CLI command override (rev. below)
  model?: string                  // CLI model (rev. below)
  error?: string                  // nothing usable — show a notice
}
// REVISED (Lead, L0): the frozen sketch `resolveCategoryProvider(category)`
// could not resolve a user's per-category choice — the assignment must be an
// input. Real signature takes the caller-derived assignment (App maps the
// selected AiModelConfig → CategoryAssignment) plus an injectable resolver seam
// (mirrors CocreateDeps), and CategoryResolution carries command/model for the
// CLI path. See services/llm/model-roles.ts.
export interface CategoryAssignment {
  runtime: 'api' | 'ollama' | 'codex' | 'claude-code' | 'cursor'
  providerId?: string
  model?: string
  command?: string
}
export async function resolveCategoryProvider(
  category: ModelCategory,
  assigned?: CategoryAssignment,
  deps?: { resolveProvider?: (providerId?: string, model?: string) => Promise<LlmProvider> }
): Promise<CategoryResolution>

// packages/core/llm/observer-prompts.ts
export function buildObserverEvaluatorSystem(): string
export function buildObserverEvaluatorUserText(input: ObserverEvaluatorInput): string
export function buildObserverContributorSystem(): string
export function buildObserverContributorUserText(input: ObserverContributorInput): string

// packages/core/llm/observer-passes.ts
export async function observerEvaluate(provider: LlmProvider, input: ObserverEvaluatorInput, fetchImpl?: FetchLike):
  Promise<{ decision: ObserverDecision | null; serverMs: number; model?: string; error?: string }>
export async function observerContribute(provider: LlmProvider, input: ObserverContributorInput, fetchImpl?: FetchLike):
  Promise<{ contribution: ObserverContribution | null; serverMs: number; model?: string; error?: string }>

// services/llm/observer.ts — resolves provider, runs passes, executes the
// search path (relay via existing searchWeb), assembles ObserverContributionResult.
```

---

## 3. Engine gate semantics (deterministic; the model gates nothing)

`pushSignals` runs gates **in this order**; the first failure logs a
`kind: 'skip'` record with that gate name and returns:

| # | Gate | Condition to pass |
|---|---|---|
| 1 | `not-running` | `start()` called, `stop()` not |
| 2 | `disabled` | `setEnabled(true)` |
| 3 | `empty-batch` | batch has ≥ 1 signal |
| 4 | `already-evaluated` | newest signal `ts` > `state.lastEvaluatedSignalTs` |
| 5 | `evaluating` | no evaluator/contributor call in flight |
| 6 | `cooldown` | `now - (lastEmittedAt ?? 0) >= effectiveCooldownMs` |
| 7 | `cocreate-in-flight` | `deps.isCocreateStreaming()` is false |

After a passing run: set `lastEvaluatedSignalTs` to the newest signal ts
**before** awaiting the evaluator (prevents double evaluation), log
`kind: 'evaluation'` with the decision and latency.

If `decision.emit` is true → call `deps.contribute`. Before emitting:

- `duplicate-title`: normalized keyword (lowercase, trimmed, whitespace
  collapsed) exactly matches a `getContext().noteTitles` entry or a
  `state.recentTopics` entry → skip, log gate.
- Source-card dedup: drop any `sources` entry whose URL is in
  `getContext().existingUrls` (this alone never blocks the emission).

On emit: fire `onEmit`, set `lastEmittedAt`, push normalized topic into
`recentTopics` (cap `maxRecentTopics`, drop oldest), log `kind: 'emission'`.

**Stale-generation:** `reset()` increments an internal generation counter
(same pattern as `SignalEngine.gen`, see `apps/web/src/signal-engine.ts:96`).
Any await that resumes with a stale generation logs `skip` /
`stale-generation` and discards the result.

**Rejection backoff:** `effectiveCooldownMs = config.cooldownMs * 2` while
`state.consecutiveRejected >= 3`. `recordOutcome('rejected')` increments the
counter, `'kept'` resets it to 0, `'post-session-ignored'` increments
`postSessionIgnored` only (no cooldown effect in MVP).

**Errors:** evaluator/contributor returning `null` or a result with `error`
→ log `kind: 'error'`, no emission, no state change other than
`lastEvaluatedSignalTs`. Never throw out of `pushSignals`.

**`listener-unavailable`:** this gate value exists in `ObserverGate` but is
**never produced by the engine** — the app layer logs it (and shows a visible
notice) when no Listener-category model can be resolved, before the engine is
even started. Engine tests do not cover it.

---

## 4. Constants

| Name | Value | Where used |
|---|---|---|
| `DEFAULT_BASE_MODEL` | `'openai/gpt-oss-120b'` on provider `groq` | model-roles fallback (switchable constant) |
| `DEFAULT_COOLDOWN_MS` | `75_000` | engine config default |
| `DEFAULT_MAX_RECENT_TOPICS` | `8` | engine config default |
| `MAX_BULLETS` | `3` | contribution parse + prompts |
| `MAX_SOURCE_CARDS` | `3` | services search assembly |
| `OBSERVER_LOG_CAP` | `500` | observer-log default cap |
| `DEFAULT_NOTE_W` / `DEFAULT_NOTE_H` | `260` / `160` | placement |
| `PLACEMENT_STEP` | `40` | placement ring step |
| `PLACEMENT_MARGIN` | `24` | placement overlap padding |
| `PLACEMENT_MAX_RING` | `6` | placement fallback trigger |

Constants live next to their consumer (engine constants in
`observer-engine.ts`, placement constants in `observer-placement.ts`, etc.),
exported so tests can reference them.

---

## 5. MVP scope locks (do not expand)

- **Two model categories only** (`ModelCategory` in the types file):
  **Listener** (signal extraction, organize, observer evaluator, Project
  Memory Stage-A) and **Thinker** (co-creation, commands, observer
  contributor). Both default to `DEFAULT_BASE_MODEL`; user assignment per
  category overrides when usable. Legacy per-role selections migrate:
  `transcriptionSummary` → Listener; `coCreation` → Thinker (`aiCommand`
  discarded when it differs).
- **The evaluator runs on the Listener category** — a non-streaming
  `chatCompletion` call, web providers only. CLI runtimes are never offered
  for Listener.
- **The contributor runs on the Thinker category** — non-streaming for web
  providers; for CLI runtimes it reuses the existing local-runtime transport
  (collect the output, then parse) and performs its own native search.
- Search routing: Thinker on a CLI runtime → `'cli-native'` (the runtime
  searches; no relay call). Thinker on a web provider → `'relay'` via the
  existing `/api/search`, or `'none'` when unconfigured. Provider-native
  search *tools* (Anthropic/OpenAI web-search APIs) remain out of scope.
- **Nothing fails silently.** No usable Listener model → observer off with a
  visible notice + `listener-unavailable` log record. Search failure → empty
  `sources`, never fabricated.
- **CLI-native sources are empty in the MVP (Lead clarification, L3).** The
  frozen contributor protocol (§1.2) carries no source-URL field and bullets are
  banned from containing URLs, so a CLI Thinker's native search informs its
  bullets but produces no extractable cards — `services/llm/observer.ts` returns
  `sources: []` with `searchPath: 'cli-native'`. Extracting CLI-native source
  cards would need a protocol/parser change and is deferred past the MVP.
- Confidence is never a gate. `Quiet` mode does not exist yet.
- No embeddings, no normalized-string topic similarity beyond the exact
  normalized match in section 3.

---

## 6. Cross-references

- Primary type file: `packages/core/llm/observer-types.ts` (frozen).
- Feature plan: `docs/observer-agent-implementation-plan.md`.
- Implementer task order and acceptance checks:
  `docs/observer/implementer-playbook.md`.
- Lead plan: `docs/observer/lead-plan.md`.
