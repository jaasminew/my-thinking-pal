# Observer Feature — Implementer Playbook

You are the **Implementer** for the transcript-driven observer feature in the
Thinking Pal repository (`thinking-pal-units`, branch
`feature/observer-agent`). This file is your complete instruction set. A
separate Lead owns the design, the prompts, the LLM passes, the services
wiring, and all integration into the app. Your job is to build the
well-specified, self-contained modules below, in the exact order given.

**Read this whole file, then `docs/observer/contract.md`, then
`packages/core/llm/observer-types.ts`, before touching any code.**

---

## 0. Golden rules

1. **Do not plan or redesign.** Implement exactly what each task specifies.
   If a task is ambiguous, or a type/signature you need is missing from the
   contract, **STOP and ask the Lead** — do not guess or invent an interface.
2. **Work in queue order** (I1 → I5). If the order looks wrong (a task needs
   something a later task builds), that's a bug in this playbook — flag it,
   don't work around it.
3. **Respect the STOP gates** (section 2).
4. **Never touch Lead-owned files** (section 5).
5. **Do not wire anything into the app.** You build modules in isolation; the
   Lead mounts them. In particular: never edit `App.tsx`, never call any LLM,
   never touch the network or `localStorage`.
6. After each task, run its acceptance check, then report `[Task ID] done —
   <one line>` and move on.

---

## 1. What we're building (context only — do not act on this section)

Thinking Pal is a canvas app where live speech is transcribed and distilled
into "signals". The observer watches fresh signal batches and occasionally
creates a new pending AI note on the canvas — an angle the discussion missed.
An LLM evaluator decides *whether* to contribute and a contributor generates
the note content; **your modules are the deterministic machinery around
them**: parsing model output, scheduling/gating, placement geometry, and a
persisted log. All LLM calls and app wiring are the Lead's.

Constants you'll need are frozen in `docs/observer/contract.md` §4 (cooldown
75 000 ms, topic cap 8, bullet cap 3, log cap 500, placement geometry).

Repo conventions to match: TypeScript, 2-space indent, no semicolon-free
style changes, colocated `*.test.ts` files, Vitest (`npm test` runs
`vitest run`). Look at `apps/web/src/signal-engine.ts` and
`packages/core/llm/parse.ts` for tone: defensive parsing, never throw on
model junk, comments explain constraints not mechanics.

---

## 2. STOP gates

- **GATE A (start):** Do not begin until `packages/core/llm/observer-types.ts`
  exists and its header contains `CONTRACTS FROZEN`. It does at handoff. If
  any task needs a type or signature not in that file or in
  `docs/observer/contract.md`, **stop and ask.**
- **GATE B (end):** After I5, **stop.** Report "queue complete". Do not
  integrate, wire, or mount anything.
- **Ad-hoc:** any ambiguity → stop and ask, never improvise.

---

## 3. The task queue

Every signature referenced below is written out in full in
`docs/observer/contract.md` §2 — implement it **exactly**.

### Task I1 — Structured-output parsers

- **Create:** `packages/core/llm/observer-parse.ts`,
  `packages/core/llm/observer-parse.test.ts`
- **Goal:** turn raw model text into `ObserverDecision` /
  `ObserverContribution`, or `null` on anything malformed.
- **Implement:** `parseObserverDecision`, `parseObserverContribution` per
  contract §2.1, with the exact wire formats and malformed-input rules of
  contract §1.1 and §1.2.
- **Behavior:** never throw. JSON may arrive fenced in ```` ``` ```` or
  surrounded by prose — extract the first balanced `{...}` block. Bullets cap
  at 3 (keep the first 3, drop the rest).
- **Do not:** call any model, log anything, or add fields beyond the frozen
  types.
- **Acceptance:** `npx vitest run packages/core/llm/observer-parse.test.ts`
  green, covering at minimum: valid emit-true, valid emit-false, fenced JSON,
  JSON with surrounding prose, missing `emit`, bad `opportunityType`,
  emit-true without topic, non-numeric confidence → 0, valid contribution,
  contribution without KEYWORD → null, zero bullets → null, >3 bullets
  capped, SEARCH line present/absent/empty, `*` bullets, garbage input.

### Task I2 — Search-path resolution

- **Create:** `services/llm/observer-search.ts`,
  `services/llm/observer-search.test.ts`
- **Goal:** pure mapping from provider id + relay availability to a
  `SearchPath`.
- **Implement:** `resolveSearchPath` per contract §2.2.
- **Do not:** import provider config, call the network, or special-case
  anything beyond the three CLI runtime ids.
- **Acceptance:** targeted vitest run green: each CLI id → `'cli-native'`;
  web id + relay → `'relay'`; web id no relay → `'none'`; unknown id follows
  the web-id rules.

### Task I3 — ObserverEngine

- **Create:** `apps/web/src/observer-engine.ts`,
  `apps/web/src/observer-engine.test.ts`
- **Goal:** the scheduling/gating state machine. All I/O is injected via
  `ObserverEngineDeps`; the engine itself is pure of network, DOM, and
  storage.
- **Implement:** the `ObserverEngine` class per contract §2.3, with gate
  order, state transitions, topic normalization, source-URL dedup,
  generation-counter staleness, rejection backoff, and error handling
  **exactly as specified in contract §3**. Constants from contract §4,
  exported.
- **Behavior details:**
  - `pushSignals` is fire-and-forget from the caller's view: it kicks an
    internal async cycle and never throws or returns a promise the caller
    must handle.
  - `initialState` missing → `{ lastEvaluatedSignalTs: 0, recentTopics: [],
    consecutiveRejected: 0, postSessionIgnored: 0 }`.
  - `getState()` returns the live state object's current values (a shallow
    copy is fine).
  - Use `deps.now?.() ?? Date.now()` for every timestamp read.
- **Do not:** implement any prompt, parsing, search, persistence, or note
  placement; do not import from `services/` or touch `App.tsx`.
- **Acceptance:** targeted vitest run green using mock deps and an injected
  `now`, covering at minimum: every gate in contract §3's table fires in
  order and logs its name; happy path evaluate → contribute → `onEmit` +
  `emission` log; `emit: false` → no contribute call; duplicate normalized
  title vs `noteTitles` and vs `recentTopics` → skip; source-URL dedup drops
  the card but still emits; cooldown blocks then unblocks as `now` advances;
  backoff doubles effective cooldown at 3 consecutive rejects and a keep
  resets it; `reset()` mid-evaluate discards the late result
  (stale-generation log); evaluator `null` and contributor `error` → error
  log, no emission; `lastEvaluatedSignalTs` prevents re-evaluating the same
  batch.

### Task I4 — Placement geometry

- **Create:** `apps/web/src/observer-placement.ts`,
  `apps/web/src/observer-placement.test.ts`
- **Goal:** deterministic, collision-free position for a new observer note.
- **Implement:** `placeObserverNote` per contract §2.4 with the §4 geometry
  constants, exported.
- **Do not:** read note data structures, the DOM, or any app state — inputs
  are plain rects.
- **Acceptance:** targeted vitest run green: empty canvas → first candidate
  (right of anchor); occupied first candidate → next ring position; dense
  cluster exhausting `PLACEMENT_MAX_RING` rings → below bottom-most rect at
  anchor.x; margin respected (a rect `PLACEMENT_MARGIN - 1` px away counts
  as overlap); pure/deterministic (same inputs → same output).

### Task I5 — Observer log

- **Create:** `apps/web/src/observer-log.ts`,
  `apps/web/src/observer-log.test.ts`
- **Goal:** capped append-only log with injected persistence.
- **Implement:** `makeObserverLog` per contract §2.5; default cap
  `OBSERVER_LOG_CAP` (500), exported.
- **Behavior:** `load` is called once at construction; every `append` saves
  the full (capped) array via `save`; oldest records drop first; `all()`
  returns a copy.
- **Do not:** touch `localStorage` directly or import from `persist.ts` —
  persistence fns are injected.
- **Acceptance:** targeted vitest run green: append persists; cap drops
  oldest; pre-existing loaded records are retained and count toward the cap;
  `all()` mutation doesn't corrupt internal state.

---

## 4. Coordination protocol

1. Verify GATE A. If unsatisfied, report "Blocked on contract" and wait.
2. Run the queue in order. After each task: acceptance check green → report
   `[I#] done — <one line>`; red → fix; blocked → stop and ask.
3. At GATE B report "queue complete" and wait.
4. If the Lead posts a revised contract mid-queue, re-read it before
   continuing.

---

## 5. Files you must NEVER edit (Lead-owned)

- `packages/core/llm/observer-types.ts` — the frozen contract (read-only)
- `packages/core/llm/observer-prompts.ts`, `observer-passes.ts`
- `packages/core/llm/passes.ts`, `prompts.ts`, `parse.ts`, `chat.ts`,
  `stream.ts`, `index.ts` (and any other existing file in
  `packages/core/llm/` — you only ADD the two I1 files)
- `services/llm/observer.ts`, `services/llm/model-roles.ts`,
  `services/llm/cocreate.ts`, and every existing file in `services/llm/` —
  you only ADD the two I2 files
- `apps/web/src/App.tsx`, `signal-engine.ts`, `canvas-types.ts`,
  `persist.ts`, and every other existing file in `apps/web/src/` — you only
  ADD the six I3-I5 files
- Everything under `docs/`

If a task appears to need one of these, **stop and ask.**

---

## 6. Validation before reporting the queue complete

```bash
npm test        # full suite — yours AND pre-existing tests must pass
npm run build
```

Both must pass. Report failures with the output; do not report "done" on red.
