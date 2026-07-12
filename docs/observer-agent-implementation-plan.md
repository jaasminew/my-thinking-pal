# Transcript-Driven Observer: Implementation Plan

## 1. Purpose

Thinking Pal currently supports reactive AI co-creation: a human creates or
changes a note, and the AI extends that note. The observer adds a complementary
mode. It watches the live discussion, decides whether the conversation would
benefit from an intervention, and can create a new AI keyword note without
waiting for a human to write first.

The observer is not a separate autonomous agent platform. It is an orchestration
layer around capabilities the project already has:

- Soniox real-time speech transcription.
- `SignalEngine` transcript buffering and typed signal extraction.
- Client-direct co-creation models.
- The existing `SEARCH:` protocol line plus the `/api/search` Tavily relay.
- Native search inside local CLI runtimes (claude-code, codex, cursor).
- Pending AI notes and cards with keep/reject behavior.
- Kept and rejected suggestions as future context.

## 2. Goals

The observer should:

- React within approximately 2-3 minutes of a meaningful development
  (bounded by the existing 2-minute signal-extraction cadence, not by
  polling).
- Remain silent when it has nothing valuable to add.
- Add connections, missing considerations, risks, comparisons, examples,
  questions, or credible sources.
- Avoid summarizing or repeating the transcript and existing canvas content.
- Never overwrite or silently edit human-authored content.
- Create visually distinct, pending AI content that users can keep or reject.
- Match the dominant language of the conversation.
- Use the two-category model selection (Listener for the evaluator, Thinker
  for the contributor) and the existing search paths.
- Work without search; conceptual contributions need no search provider.

## 3. Desirable Product Result

During a focused 30-minute discussion, the observer should usually create a
small set of worthwhile interventions rather than a continuous feed. An initial
target is 3-8 notes, depending on the number of meaningful topic changes.

A successful contribution should feel like a thoughtful participant adding an
angle the group has not yet considered. It should not feel like meeting minutes,
a transcript summary, or an AI notification generated merely because a timer
expired.

The existing and new co-creation modes should remain distinct:

| Mode | Trigger | Main behavior |
| --- | --- | --- |
| Existing co-creation | Human note creation or editing | Extends a selected human idea |
| Observer co-creation | Freshly extracted transcript signals | Creates a new AI-originated idea note |

## 4. End-to-End Workflow

```text
Soniox finalized transcript
          |
          v
SignalEngine extraction (~1 min cadence)
          |
          v
onSignals fires with fresh typed signals
          |
          v
Deterministic gates: cooldown, dedup, AI enabled,
no reactive co-creation stream in flight
          |
          v
Evaluator: should AI contribute?
          |
      +---+---+
      |       |
     No      Yes
      |       |
Stay quiet    v
        Generate contribution
        (may emit SEARCH: line -> /api/search relay,
         or native search in CLI runtimes)
              |
              v
   Add pending AI note to the canvas
              |
              v
          Keep or reject
```

The observer does not read the raw transcript stream and does not poll on a
timer. It subscribes to `SignalEngine.onSignals`: the extraction pass is
already a precision filter for meaningful speech (decisions, objections,
judgments, examples), so a fresh signal batch *is* the "meaningful development"
event. This removes the need for a separate word-count threshold and keeps
evaluator calls proportional to actual signal, not elapsed time.

The extraction cadence stays at the existing 2 minutes: shorter windows risk
giving the extraction model too little speech to classify well, and the
observer's target of 3-8 notes per 30 minutes does not need faster reaction.

Interim Soniox text never reaches the observer; the extraction pass already
operates only on finalized speech.

## 5. Observer Decision Contract

Add a structured decision returned by the evaluator:

```ts
interface ObserverDecision {
  emit: boolean
  /** Logged for replay analysis only — never used as a runtime gate. */
  confidence: number
  opportunityType:
    | 'missing-angle'
    | 'connection'
    | 'comparison'
    | 'risk'
    | 'example'
    | 'question'
    | 'source'
  topic: string
  reason: string
  needsResearch: boolean
  suggestedSearchQuery?: string
}
```

`emit` is the model's binary answer and is taken at face value once the
deterministic gates have passed. `confidence` is recorded in hidden metadata
for later analysis; model-reported confidence is not calibrated and shifts
whenever the prompt or the user-selected model changes, so no threshold is
applied to it at runtime.

The evaluator receives:

- The fresh signal batch that triggered this evaluation.
- Approximately the last 2-5 minutes of transcript context.
- Existing canvas note titles and settled content.
- Recent pending and emitted observer contributions, including their topics.
- Kept and rejected AI suggestions.
- Dominant spoken language.

The evaluator should return `emit: false` when it finds only a summary,
repetition, generic advice, a weak association, or an unfinished thought.
Seeing recent observer topics in context is the primary duplicate defense;
the prompt instructs the evaluator not to re-emit them.

### Desirable result

Real sessions produce parseable decisions. Ordinary conversation and small
talk usually result in silence.

## 6. Observer Scheduler

Add an `ObserverEngine` with a lifecycle similar to `SignalEngine`. Its
responsibility is scheduling and state management, not note writing.

It should:

- Subscribe to `SignalEngine.onSignals` as its only trigger.
- Apply deterministic gates before calling the evaluator.
- Prevent overlapping evaluator calls.
- Cancel work when AI co-creation is disabled or the recording stops.
- Ignore late responses after the active canvas changes, reusing the
  generation-counter staleness pattern from `SignalEngine` (`gen` bump on
  reset; late async results compare and drop).
- Ensure the same signal batch is not evaluated twice.
- Hold evaluation while a reactive co-creation stream is in flight, and feed
  just-emitted reactive content into the next evaluator context, so the two
  modes do not produce overlapping notes for the same moment.

Initial policy:

- Evaluate on each fresh signal batch that passes the gates.
- Emit no more than once every 60-90 seconds (cooldown).
- Suppress recently emitted topics.
- Back off after repeated rejections (see section 10 for what counts).

## 7. Evaluator Model Pass

Add a non-streaming structured LLM pass alongside the existing signal
extraction and transcript organization passes, following the conventions in
`packages/core/llm/passes.ts` (strict parse, skipped-vs-error outcomes).

Model selection is consolidated into two user-facing categories:

- **Listener** (speech-side, values speed): signal extraction, transcript
  organize, the observer **evaluator**, and Project Memory Stage-A selection.
  Web providers only — CLI runtimes are never offered here.
- **Thinker** (content-side, values quality): co-creation, commands, and the
  observer **contributor**. Any provider, CLI runtimes included.

Both categories default to Groq `gpt-oss-120b` (a switchable constant). A
user-assigned model per category overrides the default when usable; when it
is not usable the default applies; when the Groq key is also missing the
dependent features disable with a visible notice — never silently. Pinning
the evaluator to the Listener category keeps its prompt calibration stable
across users' Thinker choices.

The evaluator prompt should prioritize:

- Precision over activity.
- New value over summarization.
- Awareness of existing canvas content.
- Respect for rejected suggestions.
- Evidence requirements for factual claims.
- Permission to return nothing.

Application code must apply deterministic gates around the model result:

```text
fresh signal batch exists
+ cooldown has expired
+ topic is not a recent duplicate
+ AI mode is enabled
+ no reactive co-creation stream in flight
+ evaluator returned emit: true
= generate a candidate contribution
```

The model must not be responsible for cooldowns, duplication, lifecycle, or
authorization to change the canvas. There is no confidence threshold; the
gates above and the prompt are the controls.

### Desirable result

In real usage, most emitted notes feel worth keeping. False positives are
more costly than silence.

## 8. Contribution Generation

After an approved decision, invoke a contributor pass using the selected
Thinker-category model. It should create:

- An optional short keyword or title.
- One to three concise bullets.
- Up to three source cards when research was performed.
- An optional source image only when it materially supports the idea.
- Hidden metadata containing the opportunity type and evaluator reason.

Example:

```text
Offline synchronization

- Conflict resolution is a separate decision from database selection.
- Compare last-write-wins, field-level merge, and CRDT approaches.
- Yjs is relevant because the current canvas already uses a CRDT.

[Yjs documentation source card]
```

The new note should be AI-originated, and all generated bullets and cards should
remain `pending`. The model should not choose canvas coordinates. Application
code should place the note near the active working area while avoiding overlap.

### Desirable result

Observer notes look and behave like native Thinking Pal notes while remaining
visually distinct from human-created notes. Human content is never modified.

## 9. Research and Search Routing

Web research is optional. A conceptual connection, question, or risk can be
generated without search. Research should be requested for current products,
technical comparisons, factual claims, statistics, case studies, and concrete
implementation examples.

The observer reuses the existing co-creation search mechanism unchanged. The
search path follows the **Thinker** category's resolution:

1. **Thinker on a web provider (Groq, etc.):** the contributor emits a
   trailing `SEARCH: <query>` line, and the app calls the existing
   `/api/search` Tavily relay (`services/llm/web-search.ts`) — the path that
   already works well in reactive co-creation.
2. **Thinker on a local CLI runtime (claude-code, codex, cursor):** the
   runtime performs its own native search during contribution generation;
   returned URLs are validated before becoming cards.
3. **No search configured:** generate a clearly conceptual contribution or
   skip a contribution that requires factual verification.

Provider-native web-search tools (Anthropic `web_search`, OpenAI Responses
API) are explicitly **out of scope** for the MVP: they would require
transport-layer changes in `chat.ts`/`stream.ts` (tool declarations, new
stream block types, citation extraction) and the existing relay already
covers the need. Revisit only if the relay proves insufficient.

Capability resolution therefore reduces to a simple check:

```ts
type SearchPath = 'cli-native' | 'relay' | 'none'
```

derived from whether the runtime is a local CLI and whether `/api/search` is
configured.

Rules:

- Do not run both search paths for the same contribution.
- Do not invent URLs when no search capability exists.
- Validate returned URLs before creating cards.
- Associate factual bullets with the sources returned by the search path.
- A search failure should not create unsupported factual claims.

### Desirable result

The observer's sourced notes work exactly like reactive co-creation's sourced
notes today, with zero new search infrastructure. It still works for
non-research contributions when no search is available.

## 10. Deduplication and Attention Control

Persist lightweight observer state per canvas:

```ts
interface ObserverState {
  lastEvaluatedSignalTs: number
  lastEmittedAt?: number
  recentTopics: string[]
  consecutiveRejected: number
  postSessionIgnored: number
}
```

Duplicate control is layered:

- Primary: the evaluator sees recent topics and emitted contributions in its
  context and is instructed not to re-emit them.
- Deterministic: reject identical source URLs; skip if the generated title
  exactly matches an existing note title.
- Deferred: normalized-string topic matching adds little (LLM topic phrasing
  rarely repeats verbatim) and embedding comparison is out of scope until
  real usage shows the layers above are insufficient.

Feedback semantics — **mid-session ignores do not count**. While people are
talking, leaving a pending note untouched is normal behavior, not a verdict.
An ignore becomes a (weak) negative signal only when:

- the session has ended and the user triages the canvas without keeping the
  note, or
- the user actively interacts with the canvas near the note and skips it.

Explicit rejects are clean negative signal at any time and drive backoff.

Initial user controls:

- `Off`: no ambient observation.
- `Active`: observation on.

The existing AI toggle maps to these two. A `Quiet` mode, if added later, is
defined by a **longer cooldown and topic-suppression window** (deterministic,
predictable knobs) — not by a confidence threshold.

### Desirable result

The observer contributes sparingly, avoids near-duplicate notes, and becomes
quieter when users explicitly reject its suggestions — without punishing
itself just because a lively discussion left notes untriaged.

## 11. Feedback and Logging (Day One)

Reuse the current keep/reject mechanism:

- Kept observer content becomes positive context.
- Rejected observer content becomes negative context.
- Post-session ignored content is a weaker negative signal (section 10).
- Repeated rejection of an opportunity type can temporarily suppress it.

**Log everything from the first run.** Every session should record, as hidden
metadata alongside the full session transcript:

- The signal batches that triggered evaluations.
- Every evaluator decision (including `emit: false`), with topic, reason,
  confidence, and opportunity type.
- Evaluator and contributor model identifiers and latency.
- Search path used: cli-native, relay, or none.
- Keep, reject, or post-session-ignore outcome per note.

This is not optional telemetry — it is how the replay test set builds itself.
Every real session Jasmine runs becomes a future fixture, so tuning later
requires no separate data-collection effort. This metadata is never rendered
as ordinary canvas content.

### Desirable result

The observer adapts within a session, and accumulated real-session logs make
later calibration possible without manufactured test data.

## 12. Suggested Code Boundaries

Keep the implementation close to existing ownership boundaries:

- `packages/core/llm/observer-types.ts`: the frozen contract — decision,
  contribution, engine, logging, and model-category types.
- `services/llm/model-roles.ts`: Listener/Thinker category resolution with
  the default-model fallback ladder.
- `apps/web/src/LlmSettingsPanel.tsx`: reduced to the two category dropdowns
  (CLI runtimes hidden from Listener).
- `apps/web/src/observer-engine.ts`: signal subscription, gates, cooldowns,
  cancellation (gen-counter pattern), and observer state.
- `services/llm/observer.ts`: resolve both categories and expose
  evaluator/contributor calls (web and CLI contributor transports).
- `services/llm/observer-search.ts`: search-path resolution.
- `packages/core/llm/observer-prompts.ts`: evaluator and contributor prompts.
- `packages/core/llm/observer-parse.ts`: strict structured-output parsing.
- `packages/core/llm/observer-passes.ts`: provider-independent
  evaluator/contributor passes, following `passes.ts` conventions.
- `apps/web/src/observer-placement.ts` / `observer-log.ts`: deterministic
  note placement; capped persisted decision log.
- `apps/web/src/App.tsx`: lifecycle wiring, the reactive-co-creation
  in-flight guard, conversion of an approved contribution into a pending
  canvas note, and the listener-unavailable notice.

Reuse existing board schema and pending item types where possible. Reuse the
existing `SEARCH:` protocol parsing and `/api/search` relay as-is. Add schema
fields only for observer metadata that must survive reload or cross-device
sync.

## 13. Testing

Unit tests (deterministic, no live models):

- Evaluator response parsing and malformed output.
- Cooldown and rejection backoff behavior.
- Duplicate URL and exact-title suppression.
- Recording stop, AI disable, and canvas-switch cancellation (gen counter).
- Reactive co-creation in-flight guard.
- Search-path resolution: cli-native, relay, none.
- No-search behavior: conceptual note or silence, never invented citations.
- Provider and search failures.
- Post-session vs mid-session ignore accounting.
- Pending observer note creation without modifying human notes.

Live-quality evaluation is **experience-first for the MVP**: run real
sessions, feel the intervention quality directly, and rely on the day-one
logging (section 11) to accumulate the material for a replay harness later.
The replay harness itself is deferred to the tuning phase.

Metrics available from logs once sessions accumulate:

- Time from signal to note.
- Evaluations and notes emitted per hour.
- Keep, reject, and post-session-ignore rates.
- Duplicate rate.
- Search success rates per path.
- Cost per hour of active conversation.
- Evaluator and contributor latency.

## 14. Delivery Phases

### Phase 0: Model categories

- Add `resolveCategoryProvider` with the fallback ladder (assigned model →
  default `gpt-oss-120b` → visible error).
- Migrate `ModelSelections` to `{ listener, thinker }` and rewire the
  existing call sites (extraction, organize, co-creation, command, Project
  Memory Stage-A).
- Reduce `LlmSettingsPanel` to the two category dropdowns, CLI runtimes
  hidden from Listener.
- Independently shippable and testable before any observer code exists.

### Phase 1: Contracts and evaluator

- Add observer decision and contribution types.
- Add strict parser and evaluator prompt.
- Implement the evaluator pass on the Listener category.
- Add parser and malformed-output unit tests.

### Phase 2: Scheduling and lifecycle

- Add `ObserverEngine` subscribed to `SignalEngine.onSignals`.
- Implement gates, cooldowns, cancellation, stale-result guards, and the
  reactive co-creation in-flight guard.
- Add deterministic tests using fake timers and mock evaluators.

### Phase 3: Canvas contribution

- Generate the contribution after evaluator approval.
- Create a new AI-originated keyword note.
- Reuse pending bullets/cards and keep/reject behavior.
- Add deterministic collision-safe placement near the active canvas area.
- Wire day-one decision/outcome logging with full-transcript retention.

### Phase 4: Search wiring

- Resolve the search path (cli-native / relay / none).
- Route the contributor's `SEARCH:` line through the existing relay.
- Support conceptual contributions when no search is available.
- Validate source and failure behavior with tests.

**MVP checkpoint: run real sessions and experience the observer end to end.**

### Phase 5: Deduplication and feedback

- Persist recent topics and observer outcomes.
- Add URL/title duplicate suppression and rejection-aware backoff.
- Implement post-session ignore accounting.

### Phase 6: Tuning from accumulated sessions

- Turn logged real sessions into replay fixtures.
- Measure usefulness, silence, latency, and cost from logs.
- Tune cooldowns, topic-suppression windows, and context-window sizes.
- Add `Quiet` mode (longer cooldown) only if real usage shows the need.

## 15. MVP Completion Criteria

The first version is complete when:

- Fresh extracted signals automatically feed observer processing.
- Meaningful speech can trigger an AI-created keyword note within ~2-3
  minutes.
- The evaluator can explicitly choose silence.
- Contributions never overwrite human content.
- Generated bullets and cards support keep/reject.
- Existing canvas ideas and recent suggestions are not repeated.
- Model selection is two user-facing categories (Listener/Thinker), both
  defaulting to Groq `gpt-oss-120b`, with legacy selections migrated.
- A missing Listener model disables the observer with a visible notice —
  never silently.
- Sourced notes work through the existing `SEARCH:` relay (web Thinkers) or
  native CLI search (CLI Thinkers), with no new search infrastructure.
- No URL or citation is fabricated when search is unavailable or fails.
- Disabling AI or switching canvases cancels or invalidates pending work.
- The observer never emits while a reactive co-creation stream is in flight.
- Existing reactive co-creation behavior remains unchanged.
- Every session logs decisions, outcomes, and the transcript for later replay.
- Observer unit tests pass; `npm test` and `npm run build` pass.

## 16. Principal Risk

The highest-risk part is evaluator calibration, not real-time transcription,
search, or canvas rendering. A technically correct observer that interrupts too
often will weaken the thinking experience.

The MVP accepts this risk deliberately: quality is judged by direct experience
first. What makes that acceptable is day-one logging — every real session
becomes replay material, so when calibration work starts in Phase 6 the test
set already exists. Implementation should optimize for precision throughout
and make silence a normal, successful result.
