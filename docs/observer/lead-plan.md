# Observer Feature — Lead Plan

The Lead's working plan. Single source of truth for design decisions; if a
question comes up mid-build that this doc already answered, point back here.

Feature spec: `docs/observer-agent-implementation-plan.md`.
Binding contracts: `packages/core/llm/observer-types.ts` + `docs/observer/contract.md`.

---

## 1. Locked design decisions

- **Trigger is `SignalEngine.onSignals`, never a timer or raw-transcript
  polling.** Extraction is already a precision filter for meaningful speech;
  a fresh signal batch *is* the trigger event. Extraction cadence stays at
  the existing 2 minutes (shorter windows starve the extraction model), so
  observer reactivity is ~2-3 minutes — accepted, since the target is 3-8
  notes per 30 minutes.
- **Confidence is metadata, not a gate.** LLM self-reported confidence is
  uncalibrated and shifts with prompt/model changes. All runtime control is
  deterministic: cooldown, dedup, enabled, in-flight guard (contract §3).
- **`emit` is taken at face value once gates pass.** Precision comes from the
  evaluator prompt + gates, not post-hoc score filtering.
- **Mid-session ignores are not negative signal.** Only explicit rejects (any
  time) and post-session ignores count. Backoff: cooldown ×2 at 3+
  consecutive rejects, reset on a keep.
- **Two model categories replace the four per-role selections.** **Listener**
  (speed-valued: signal extraction, organize, observer evaluator, Project
  Memory Stage-A selection) and **Thinker** (quality-valued: co-creation,
  commands, observer contributor). Users make exactly two model choices. Both
  default to `DEFAULT_BASE_MODEL` (Groq `gpt-oss-120b`, a switchable
  constant); a per-category user assignment overrides when usable, else fall
  back to the default, else disable dependent features with a **visible
  notice** — never silently. Migration: `transcriptionSummary` → Listener,
  `coCreation` → Thinker (a differing `aiCommand` selection is discarded).
- **Evaluator = Listener, always a web provider.** Pinning the evaluator to
  the fast category keeps prompt calibration stable; ambient every-2-min
  calls can't afford CLI startup latency or loose JSON. The Listener
  dropdown never offers CLI runtimes.
- **Contributor = Thinker, CLI runtimes included.** It fires rarely (3-8×
  per 30 min), tolerates CLI startup, and a CLI contributor does its own
  native web search (`SearchPath 'cli-native'`, reachable in MVP). Web
  Thinkers use the existing `SEARCH:` → `/api/search` relay. Provider-native
  search *tools* stay out of scope (transport-layer rework).
- **Contributor is non-streaming.** Observer notes appear whole; streaming
  buys nothing and would drag in the protocol-filter machinery. On CLI
  runtimes: reuse the local-runtime transport, collect output, parse once.
- **Engine is pure of I/O.** Evaluate/contribute/context/persistence are all
  injected (`ObserverEngineDeps`) — same testability seam as
  `requestCocreate`'s `CocreateDeps`.
- **Day-one logging is mandatory.** Every evaluation/skip/emission/error goes
  through `onLog` into a persisted per-space log (cap 500). Real sessions
  build the future replay test set; no separate data collection.
- **Observer notes are ordinary `KeywordNote`s** with all items
  `origin: 'ai'`, `status: 'pending'` — keep/reject reuse falls out for free.
  Human content is never touched by construction.

| Issue raised in plan review | Resolution here |
|---|---|
| Polling every 10-15s too costly | Signal-batch trigger; cooldown also gates evaluator calls |
| 1-min extraction starves the model | Cadence stays 2 min |
| Confidence threshold meaningless | Metadata only (contract §3) |
| Ignores punish lively sessions | `recordOutcome` semantics; mid-session ignores uncounted |
| Native search = transport rework | Web Thinkers: relay. CLI Thinkers: their own native search. No new transport |
| CLI exclusion = silent failure UX | Two-category model + visible-notice fallback ladder (L0); nothing silent |
| Four model settings confuse users | Listener/Thinker — exactly two user-facing choices |
| Observer/co-creation collision | Gate 7 `cocreate-in-flight` + emitted content in evaluator context via `canvasSummary` |
| No test set for calibration | Day-one logging with full transcript already persisted per space |

---

## 2. Core interfaces (preview — binding version in observer-types.ts)

`ObserverSignal[] → gates → ObserverDecision → ObserverContributionResult →
ObserverEmission → KeywordNote`. Engine deps inject `evaluate`, `contribute`,
`getContext`, `isCocreateStreaming`.

---

## 3. The hard parts (Lead-owned logic)

### 3.1 Evaluator prompt (L1)

The highest-risk artifact in the feature. Requirements, in priority order:
precision over activity; silence is a normal successful output; never
summarize or restate; must check the fresh signals against `canvasSummary`,
`recentObserverTopics`, and `rejected` before proposing; factual claims
require `needsResearch: true` + a search query; output is exactly one JSON
object per contract §1.1; respond in `dominantLanguage`. Include 2-3 few-shot
pairs — at least one small-talk → `emit: false` and one rejected-topic →
`emit: false`.

### 3.2 Contributor prompt (L1)

Produces contract §1.2 format. Keyword ≤ ~5 words; 1-3 bullets, each a *new
angle*, not transcript restatement; `SEARCH:` line only when the decision had
`needsResearch`; no URLs in bullets (sources come from the search path);
match `dominantLanguage`.

### 3.3 Passes (L2)

`observerEvaluate` / `observerContribute` in
`packages/core/llm/observer-passes.ts`, following `passes.ts` conventions
exactly: `chatCompletion` + `getJsonReasoningParams`, strict parse via I1,
never throw, `ChatHttpError.serverMs` preserved, parse failure → `null` +
no retry (unlike extraction, a lost observer evaluation costs nothing).

### 3.4 Model categories (L0)

`services/llm/model-roles.ts` (contract §2.6): `resolveCategoryProvider`
implementing the fallback ladder — assigned model if usable → `DEFAULT_BASE_MODEL`
on Groq → `{ error }`. Listener resolution rejects CLI runtimes outright.
Then the consolidation itself: `ModelSelections` becomes
`{ listener, thinker }` with legacy migration in `normalizeModelSelections`
(`transcriptionSummary` → listener, `coCreation` → thinker); rewire the four
existing call sites (`providerArgs`, SignalEngine extract/organize config,
`memorySelectionCall` → listener); `LlmSettingsPanel` shows two dropdowns —
"Listener (speech, fast)" / "Thinker (content, quality)" — with CLI runtimes
hidden from the Listener list. This lands first and is independently
testable before any observer code consumes it.

### 3.5 Services wiring (L3)

`services/llm/observer.ts`: resolve both categories via L0's
`resolveCategoryProvider`. Evaluator call on the Listener provider.
Contributor on the Thinker resolution: web provider → `chatCompletion`; CLI
runtime → local-runtime transport, collect output, parse once. Search:
`resolveSearchPath` (I2) with the Thinker's runtime/provider → `'cli-native'`
means the runtime already searched (validate any URLs it produced);
`'relay'` + `contribution.searchQuery` → existing `searchWeb(query, 3)`; cap
`MAX_SOURCE_CARDS`, drop invalid URLs. Assemble `ObserverContributionResult`.
Search failure → empty `sources`, never fabricated. No usable Listener →
surface the error so App shows the notice and logs `listener-unavailable`.

### 3.5 App integration (L4)

In `App.tsx`:

- Instantiate `ObserverEngine` per idea space alongside the existing refs;
  persist `ObserverState` and the log with `loadJSON`/`saveJSON` under
  `k('observer-state')` / `k('observer-log')` (via I5's `makeObserverLog`).
- Fan out `onSignals`: existing signal-log append **plus**
  `engine.pushSignals(lines)`.
- `getContext()`: note titles + kept content from `notesRef`, kept/rejected
  aggregates, existing card URLs, transcript window via existing
  `transcriptSlice(Date.now() - 300_000, Infinity)`, dominant language by
  CJK-character-ratio heuristic on that window.
- `isCocreateStreaming()`: `firesRef.current.size > 0`.
- `onEmit` → build a `KeywordNote`: `keyword` from contribution, bullets as
  `origin: 'ai'`, `status: 'pending'` `BulletItem`s (no `fireId` — observer
  emissions are atomic), sources as pending `CardItem`s, position from I4's
  `placeObserverNote` (anchor = centroid of current viewport or last-touched
  note), plus hidden metadata (opportunity type, reason) — extend
  `KeywordNote` with an optional `observerMeta` field (schema addition is
  Lead-owned).
- Wire keep/reject of observer items into `engine.recordOutcome`; wire AI
  toggle → `setEnabled`, recording stop → `stop()`, space switch → `reset()`.

---

## 4. Phasing

Follows the feature plan's phases; MVP checkpoint after search wiring, then
real-session experience before any tuning work.

---

## 5. Lead's task list

| ID | Task | Depends on |
|---|---|---|
| F1 | Freeze contract: `observer-types.ts` + `docs/observer/contract.md` ✅ done (rev. for model categories) | — |
| L0 | Model categories: `model-roles.ts` resolver, `ModelSelections` migration, call-site rewiring, two-dropdown `LlmSettingsPanel` | F1 |
| L1 | Evaluator + contributor prompts (`observer-prompts.ts`) | F1 |
| L2 | Passes (`observer-passes.ts`) + prompt-assembly tests | F1, **I1** |
| L3 | Services wiring (`services/llm/observer.ts`) + tests with mock provider/fetch | L0, L1, L2, **I2** |
| L4 | App integration: engine lifecycle, note conversion, persistence, feedback wiring, listener-unavailable notice | L3, **I3, I4, I5** |
| L5 | End-to-end verify: live session smoke test, `npm test`, `npm run build` | all |

---

## 6. Sequencing & blocking

```
[F1 — Lead, done] ─────────────────────── gates everyone
        │
Implementer:  I1 → I2 → I3 → I4 → I5     (serial; I1/I2 front-loaded because the Lead needs them first)
        │      │    │     │    │    │
Lead:    L0 → L1 ──┼──→ L2 → L3 ────┼──→ L4 (integration) → L5 (verify)
               │   │                │
       L2 waits on I1 (parse import)
       L3 waits on I2 (resolveSearchPath import) and L0 (category resolver)
       L4 waits on I3, I4, I5 (engine, placement, log)
       Nothing blocks L0/L1 — settings refactor and prompts touch only
       Lead-owned files; start both immediately.
```

Minimum Implementer subset the Lead needs early: **I1, then I2**. I3-I5 can
land any time before L4. If the Implementer stalls, the Lead can still finish
L0/L1 and draft L2/L3 against the frozen signatures (they just won't compile
until the files exist). L0 doubles as the first shippable slice: the
two-category settings panel is user-visible and testable before any observer
code exists.

---

## 7. Tests & validation

- **Lead's coverage:** L0 — `resolveCategoryProvider` fallback ladder
  (assigned → default → error), Listener rejects CLI runtimes, legacy
  selection migration; prompt-assembly snapshots (evaluator/contributor user
  text contains signals, canvas summary, rejected topics, language tag);
  `services/llm/observer.ts` with mock provider + mock fetch: happy path,
  CLI-Thinker path (native search, URL validation), relay path, search
  failure → empty sources, URL cap, listener-unavailable surfacing.
- **Implementer's coverage:** per-task acceptance checks in the playbook.
- **Gate before done:** `npm test && npm run build`, plus one real recorded
  session with the log inspected (every evaluation present, gates named on
  every skip).
