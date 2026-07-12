# AI Pal Cursor — Build Plan

A single FigJam-style AI cursor on the canvas that appears at/below the
keyword note the AI is working on, with a status pill ("AI pal · thinking /
writing / found sources"). It travels smoothly between notes, keeps constant
screen size at any zoom, and content shows up **one activity at a time**
under the cursor even when fires run concurrently. It lingers 2 minutes after
the last activity, then fades out. It is never interactive.

Branch: `AI-cursor`. All work is in `apps/web/src/`.

---

## 0. Roles & how to use this doc

- **Implementer (you):** build everything specified here, in the task order
  of §10. Each task lists exact files, exact behavior, and an acceptance
  check. Run each check before moving on.
- **Supervisor (separate reviewer):** reviews your code against this plan
  after each task and at the end. Does not write feature code.

**Golden rules**

1. Implement exactly what this doc specifies. If something is ambiguous or a
   type you need isn't defined here, **STOP and ask the supervisor** — do not
   invent an interface or redesign.
2. Work in task order (§10). Later tasks import earlier ones.
3. Keep the pure modules pure: `ai-cursor.ts` and `ai-reveal.ts` import no
   React, do no I/O, touch no DOM.
4. Match existing code conventions (look at neighboring files: 2-space
   indent, no semicolons, Vitest tests co-located as `*.test.ts(x)`).
5. Don't reformat or refactor code the task doesn't name. The two existing
   files you edit (`App.tsx`, `observer-engine.ts`) get surgical changes
   only — described precisely in Tasks 5 and 6.

---

## 1. User-facing behavior (what "done" looks like)

- When the AI starts working on a note (ambient co-creation, or the observer
  creating a new note), an orange arrow cursor labeled **"AI pal · thinking"**
  fades in just below that note.
- The label updates as the AI progresses: `thinking` → `writing` (when text
  starts landing) → `found sources` (when source cards land).
- If several fires run at once, their output does **not** appear all at once.
  Content lands one note at a time; the cursor is always at the note whose
  content is currently appearing. When one finishes, the cursor travels to
  the next and that note's content fills in at a quick, readable pace.
- The cursor stays constant size regardless of zoom, and stays put (screen-
  tracking) during pan/zoom without lag.
- 2 minutes after the last activity ends, the cursor fades out. The next
  activity fades it back in at the new location.
- The cursor never responds to clicks or hover.

---

## 2. Locked design decisions

- **One cursor, one identity.** Orange (`var(--accent)`, #ff7a45 — same as the
  text highlight), name **"AI pal"**. Single collaborator even though fires
  run concurrently.
- **Serialized reveal, FIFO.** Only the cursor's current activity applies its
  stream to the canvas; all others buffer invisibly and replay when their
  turn comes. Order is first-started-first-revealed. **No preemption** — this
  was considered for user commands, but commands stream into the side-panel
  chat (`sendTurn`), never onto the canvas, so every canvas fire is an
  equal-priority ambient fire. The queue is plain FIFO.
- **Labels inferred client-side** from existing stream events. No backend
  change. "Searching online" is intentionally out of scope: the server does
  web search invisibly and the client never learns when it starts.
- **Not interactive.** `pointer-events: none` throughout.
- **Constant screen size.** Rendered in a screen-space overlay outside the
  transformed notes layer; it converts world→screen itself.
- **Travels** (~600 ms ease) on target change; pan/zoom reposition instantly
  (never animated). **2-minute linger** then fade; re-appears at the new spot
  if it had faded.
- **Observer notes** show the cursor only when the CONTRIBUTOR runs (never on
  an evaluator pass that doesn't emit), at the future note's placed position;
  the note itself materializes only when the cursor reaches it.
- **Transient.** Cursor + reveal state is never persisted or synced.

---

## 3. Architecture

```
┌─ pure, unit-tested ────────────┐   ┌─ React ───────────┐
│ ai-cursor-types.ts  (types)    │   │ AiCursorOverlay.tsx│  screen-space
│ ai-cursor.ts   reduceAiCursor  │   │  + ai-cursor.css   │  render only
│ ai-reveal.ts   RevealScheduler │   └─────────▲──────────┘
└──────────▲─────────────────────┘             │ state, view
           │ imported by                        │
┌──────────┴────────────────────────────────────┴─────────────┐
│ App.tsx   (Task 5 — the wiring / integration)                │
│  useReducer(reduceAiCursor)  +  per-fire RevealSchedulers    │
│  runAi callbacks push→scheduler; currentId effect goLive();  │
│  anchorForNote() measures DOM; mounts the overlay            │
│ observer-engine.ts (Task 4 — two new callbacks)              │
└──────────────────────────────────────────────────────────────┘
```

**Data flow, co-creation fire:**
`runAi` starts → dispatch `start` + create a `RevealScheduler`. Stream
callbacks (`onText`, …) `push()` events into that fire's scheduler instead of
writing to the canvas. A `useEffect` on `cursor.currentId` calls
`scheduler.goLive(applyFireEvent, onRevealDone)` when this fire becomes
current; the scheduler drains buffered events (paced) then passes through
live. `applyFireEvent` contains the (unchanged) canvas-mutation logic. When
the fire's reveal finishes AND the network stream finished, the scheduler
calls `onRevealDone` → dispatch `end` → cursor travels to next queued
activity.

**Data flow, observer:** engine fires `onContributeStart` → dispatch `start`
for an `obs_…` activity at the pre-placed position. The emission is held
(not drawn) until that activity becomes current, then the note is created and
the cursor ends. Evaluator-only passes fire nothing.

---

## 4. Type definitions — `apps/web/src/ai-cursor-types.ts` (Task 1)

Create this file verbatim. It is the spine every other module imports.

```ts
import type { UrlCard } from '../../../services/llm/cocreate-types'

/** Status label shown in the pill next to the cursor. */
export type AiCursorLabel = 'thinking' | 'writing' | 'found sources'

/** A point in CANVAS WORLD coordinates (same space as KeywordNote.x/y). */
export interface WorldPoint {
  x: number
  y: number
}

/**
 * One in-flight AI activity the cursor could point at. activityId is the
 * co-creation fireId, or `obs_<n>` for an observer contribution. target is
 * where the cursor sits for this activity (world coords, already offset to
 * "below the note" by the caller).
 */
export interface AiActivity {
  activityId: string
  target: WorldPoint
  label: AiCursorLabel
  startedAt: number
}

/**
 * Cursor state. `activities` holds every live activity by id. `currentId` is
 * the one the cursor follows AND the reveal gate — only its content is
 * applied to the canvas. `target`/`label` mirror the current activity (or the
 * lingering last one). `lastActivityAt` drives the 2-min fade. `visible` is
 * what the overlay reads.
 */
export interface AiCursorState {
  activities: Record<string, AiActivity>
  currentId: string | null
  target: WorldPoint | null
  label: AiCursorLabel
  lastActivityAt: number
  visible: boolean
}

export const AI_CURSOR_IDLE_FADE_MS = 120_000 // 2-min linger, then fade
export const AI_CURSOR_NAME = 'AI pal'
export const AI_REVEAL_CHUNK_MS = 120        // pacing between drained events
export const AI_REVEAL_MAX_DRAIN_MS = 2_000  // cap: long backlog drains faster

/** Events the app feeds the reducer. All carry `at` (Date.now()). */
export type AiCursorEvent =
  | { type: 'start'; activityId: string; target: WorldPoint; at: number }
  | { type: 'label'; activityId: string; label: AiCursorLabel; at: number }
  | { type: 'move'; activityId: string; target: WorldPoint; at: number }
  | { type: 'end'; activityId: string; at: number }
  | { type: 'tick'; at: number }

export const initialAiCursorState: AiCursorState = {
  activities: {},
  currentId: null,
  target: null,
  label: 'thinking',
  lastActivityAt: 0,
  visible: false
}

// ---- Reveal buffering ----

/** A buffered stream event, mirroring the cocreate callbacks 1:1. */
export type BufferedFireEvent =
  | { kind: 'diagnosis'; text: string }
  | { kind: 'anchor'; line: number }
  | { kind: 'text'; chunk: string }
  | { kind: 'urls'; urls: UrlCard[] }
  | { kind: 'image'; src: string; sourceUrl?: string; title?: string; line?: number }

/**
 * Per-activity buffer + paced replayer. While not live, push() queues events.
 * goLive(apply, done) drains the queue IN ORDER, paced, then passes further
 * pushes through live. done() fires exactly once, after the queue drains AND
 * finish() has been called (either order). cancel() drops everything and
 * stops timers; apply/done are never called after cancel().
 */
export interface RevealScheduler {
  push(e: BufferedFireEvent): void
  goLive(apply: (e: BufferedFireEvent) => void, done: () => void): void
  finish(): void
  cancel(): void
  isLive(): boolean
}
```

`reduceAiCursor` and `createRevealScheduler` are declared in their own files
(Tasks 2, 3); their signatures:

```ts
export function reduceAiCursor(state: AiCursorState, event: AiCursorEvent): AiCursorState
export function createRevealScheduler(opts?: {
  chunkMs?: number
  maxDrainMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}): RevealScheduler
```

**Acceptance (Task 1):** `npx tsc --noEmit` from `apps/web/` passes with the
file in place (the `UrlCard` import resolves; nothing else imports it yet).

---

## 5. Reducer — `apps/web/src/ai-cursor.ts` (Task 2)

Pure function. No `Date.now()` inside — time rides on the event. Return the
**same reference** when nothing changed.

Rules (each is a test case):

1. **start** — add the activity to `activities`. If `currentId` is null: it
   becomes current; `target`/`label` snap to it; `visible` = true. If a
   current activity already exists: it just waits (no jump — sticky). Always
   set `lastActivityAt = at`. Special case: if `visible` was false (faded),
   the appearing activity sets `target` directly (no travel from a stale
   ghost) — this happens naturally because it becomes current.
2. **label** — set the named activity's label. If it's the current activity,
   mirror to top-level `label`. Refresh `lastActivityAt`. Unknown id → same
   reference.
3. **move** — set the named activity's target. If current, mirror to
   top-level `target`. Refresh `lastActivityAt`. Unknown id → same reference.
4. **end** — remove the activity. If it was current: pick the next current as
   the survivor with the **smallest `startedAt`** (FIFO); `target`/`label`
   travel to it; refresh `lastActivityAt`. If no survivors: `currentId` =
   null but KEEP `target`, `label`, `visible: true` (linger). Unknown id →
   same reference.
5. **tick** — if `currentId` is null AND `at - lastActivityAt >=
   AI_CURSOR_IDLE_FADE_MS`, set `visible: false`. Otherwise same reference.
   Never hides while an activity is live.

**Acceptance:** `npx vitest run src/ai-cursor.test.ts` green, covering all 5
rules incl.: sticky (second start doesn't steal), FIFO succession on end,
linger-then-fade (`start → end → tick just under 120 000 → still visible;
tick ≥ 120 000 → hidden`), unknown-id and no-op-tick return same reference,
and re-appear after fade (`… hidden → start → visible with new target`).

---

## 6. Reveal scheduler — `apps/web/src/ai-reveal.ts` (Task 3)

Content-agnostic plumbing: it never inspects what an event means.

Behavior:

- Before `goLive`: `push(e)` appends to an internal FIFO array; nothing
  applied.
- `goLive(apply, done)`: drain the array in order, one event per interval.
  Interval = `chunkMs` (default `AI_REVEAL_CHUNK_MS`), but if
  `queue.length * chunkMs > maxDrainMs`, compress to `maxDrainMs /
  queue.length` so the whole backlog lands within `maxDrainMs`. Events pushed
  during the drain append to the queue (never jump ahead). Once the queue is
  empty, further `push(e)` calls `apply(e)` synchronously (live
  pass-through).
- `finish()`: marks the upstream stream complete.
- `done()`: called exactly once, when the queue is empty AND `finish()` has
  been called (either order — finish-then-drain and drain-then-finish both
  end in one `done()`). Empty buffer + already finished at `goLive` time →
  `done()` once.
- `cancel()`: clear the queue, stop all timers; `apply`/`done` never fire
  afterward. `goLive` called twice, or `push`/`finish` after `cancel`, are
  no-ops (must not throw).
- `isLive()`: true from `goLive` until `cancel`.
- Timers via injectable `setTimeoutFn`/`clearTimeoutFn` (default global
  `setTimeout`/`clearTimeout`) so tests drive time.

**Acceptance:** `npx vitest run src/ai-reveal.test.ts` green, covering:
buffered events apply in push order after `goLive`; pacing honors `chunkMs`
and compresses to `maxDrainMs`; live pass-through after drain; `done()`
exactly once in both orderings; `cancel()` mid-drain stops all further
`apply`/`done`; pushes during drain don't jump the queue. Use injected fake
timers.

---

## 7. Overlay — `apps/web/src/AiCursorOverlay.tsx` + `ai-cursor.css` (Task 4 build; mounted in Task 5)

```ts
export interface AiCursorOverlayProps {
  state: AiCursorState
  view: { x: number; y: number; scale: number }
}
export function AiCursorOverlay(props: AiCursorOverlayProps): JSX.Element | null
```

Behavior:

- **World→screen per render:** `left = target.x * view.scale + view.x`,
  `top = target.y * view.scale + view.y`. Absolutely positioned; the overlay
  is mounted inside a `position: relative` parent (`.canvas`, Task 5). If
  `target` is null, render null.
- **Constant size:** the glyph and pill take NO `view.scale` — fixed pixels,
  like a FigJam collaborator cursor.
- **Travel vs. view-change (the subtle part):** animate ONLY when
  `state.target` changed; never when only `view` changed. Keep the previous
  **world** target in a ref. On render: if the world target is unchanged,
  apply the screen position with no transition (pan/zoom tracks instantly);
  if it changed by ≥ 24 screen px, enable a ~600 ms `transform` transition
  (ease-in-out) for that move; below 24 px, snap without transition. (FLIP or
  a transition-toggle both fine — the observable behavior above is the
  contract.)
- **Fade:** opacity ~200 ms in when `visible` flips true, ~400 ms out when it
  flips false; render null once fully faded out (via `transitionend` or a
  timeout).
- **Look:** inline SVG arrow-cursor glyph, tip at the positioned point, ~20 px
  tall, fill `var(--accent)`, subtle drop shadow. Pill offset ~14 px right /
  ~18 px down from the tip: `background: var(--accent)`, white text ~12 px,
  border-radius ~6 px, padding ~2px 8px, text `` `${AI_CURSOR_NAME} · ${state.label}` ``.
  `pointer-events: none` on everything.
- Styles live in `ai-cursor.css`, imported by the component. Do NOT edit
  `styles.css` or `design-system.css`.

**Acceptance:** `npx vitest run src/AiCursorOverlay.test.tsx` green: renders
null when `target` null; pill text is `AI pal · writing` for that label;
position math for world (100, 50) with view `{x:10,y:20,scale:2}` → left 210,
top 120; `pointer-events: none` present. (Animation timing is verified live
by the supervisor, not in jsdom.) Then `npx tsc --noEmit` passes.

---

## 8. Observer engine hooks — `apps/web/src/observer-engine.ts` (Task 5a; do WITH Task 6)

Add two optional callbacks next to the existing `onEmit`/`onLog`
([observer-engine.ts:41](apps/web/src/observer-engine.ts)):

```ts
onContributeStart: () => void = () => {}
/** Fires exactly once per contribute call, after it settles.
 *  emitted=true only when onEmit fired for this cycle. */
onContributeSettled: (emitted: boolean) => void = () => {}
```

Insertion points inside the internal cycle
([observer-engine.ts:181–300](apps/web/src/observer-engine.ts)):

- Call `this.onContributeStart()` immediately BEFORE `await
  this.deps.contribute(contribInput)` (currently ~line 248), i.e. after the
  `emit:false → return` check so it never fires on an evaluator pass.
- Call `this.onContributeSettled(emitted)` **exactly once on every exit path
  after** that await: the `catch` (contribute threw), the stale-generation
  check, `result === null`, `result.error`, the duplicate-title gate, and the
  success path (after `this.onEmit(...)`). `emitted` is true only on the
  success path. The cleanest implementation wraps the post-await body so a
  single settle call can't be missed — but however you do it, a missed path
  means a cursor that never leaves, so this is the thing to test hardest.

**Acceptance (engine):** extend `observer-engine.test.ts` — `onContributeStart`
fires only when contribute is reached (never on gate-4/5/6 skips or an
`emit:false` decision); `onContributeSettled` fires exactly once with the
right `emitted` for each of: contribute throw, stale generation, null result,
result.error, duplicate-title, success. Existing tests stay green.

---

## 9. App.tsx wiring (Task 6 — the integration; supervisor reviews closely)

This is the judgment-heavy part. Make these changes surgically.

### 9a. Cursor state + refs

Near the other canvas state (after `view`, [App.tsx:545](apps/web/src/App.tsx)):

```ts
const [cursor, cursorDispatch] = useReducer(reduceAiCursor, initialAiCursorState)
```

Add a per-fire record map (alongside `firesRef`, [App.tsx:580](apps/web/src/App.tsx)):

```ts
// Per fire/activity: its reveal scheduler + the deferred-apply local state
// (diagnosis/anchor are produced early but consumed when text is APPLIED,
// which may be much later than when they arrived — so they can't be closure
// locals anymore; they live here).
const revealRef = useRef(new Map<string, {
  noteId: string
  scheduler: RevealScheduler
  diagnosis?: string
  anchorId?: string
  firstTextApplied: boolean
}>())
```

### 9b. `anchorForNote(noteId): WorldPoint`

New helper. Read the note's DOM rect via the existing `[data-noteid]`
convention (same as [App.tsx:1336](apps/web/src/App.tsx)), take its
**bottom-left**, convert to world with the existing `toWorld`
([App.tsx:831](apps/web/src/App.tsx)). Fallback when the element isn't in the
DOM yet: the note's `(x, y)` from `notesRef.current`. The overlay adds its own
constant screen offset, so return the note's world corner as-is.

### 9c. Refactor `runAi` ([App.tsx:915–1093](apps/web/src/App.tsx))

The stream callbacks currently mutate the canvas directly. Move that logic
into one function and route callbacks through the scheduler.

1. **Extract `applyFireEvent(noteId, fireId, e: BufferedFireEvent)`** — its
   body is the current callback bodies, switched on `e.kind`:
   - `diagnosis`: `revealRef` record `.diagnosis = e.text`.
   - `anchor`: `.anchorId = humanBullets[e.line]?.id`. (Capture
     `humanBullets` into the record at fire start, or recompute from the live
     note — recomputing is safer against edits; either is acceptable, note
     the choice.)
   - `text`: the existing buffer-parse-upsert `setNotes` logic (uses the
     record's `diagnosis`/`anchorId`). After applying, if
     `!record.firstTextApplied`: set it true, `cursorDispatch({type:'label',
     activityId: fireId, label:'writing', at: Date.now()})`, and (throttled
     ~300 ms) `cursorDispatch({type:'move', activityId: fireId, target:
     anchorForNote(noteId), at: Date.now()})`.
   - `urls`: the existing card-insert `patchNote` logic, then
     `cursorDispatch({type:'label', activityId: fireId, label:'found
     sources', at: Date.now()})`.
   - `image`: the existing image-attach `patchNote` logic.
   Keep `aiBufRef`, `rejectedFireLinesRef`, `insertAnchored`, `stripMarker`,
   etc. exactly as they are — only the call site moves.
2. **At fire start** (after `firesRef.current.set`, [App.tsx:934](apps/web/src/App.tsx)):
   ```ts
   const scheduler = createRevealScheduler()
   revealRef.current.set(fireId, { noteId, scheduler, firstTextApplied: false })
   cursorDispatch({ type: 'start', activityId: fireId, target: anchorForNote(noteId), at: Date.now() })
   ```
   Keep the existing `patchNote(noteId, aiRunning:true)`.
3. **The callbacks** now just buffer:
   `onDiagnosis: d => scheduler.push({kind:'diagnosis', text:d})`,
   `onAnchor: line => scheduler.push({kind:'anchor', line})`,
   `onText: chunk => scheduler.push({kind:'text', chunk})`,
   `onUrls: urls => scheduler.push({kind:'urls', urls})`,
   `onImage: img => scheduler.push({kind:'image', ...img})`.
4. **After `await requestCocreate`** ([App.tsx:1075](apps/web/src/App.tsx)):
   - `firesRef.current.delete(fireId)` (unchanged).
   - `result.aborted`: `scheduler.cancel()`; discard the fire's partials
     (existing filter); `cursorDispatch({type:'end', activityId:fireId,
     at:Date.now()})`; `revealRef.current.delete(fireId)`; return.
   - error with no buffered text: keep the existing error-bullet behavior,
     but route it through one final apply (or apply directly since it's a
     terminal state), then `scheduler.finish()`.
   - normal: `scheduler.finish()`. Do NOT dispatch `end` here — `end` comes
     from the reveal `done()` callback (9d). Keep the existing `aiRunning:
     false` patch.

### 9d. `currentId` effect (drives reveal + end)

```ts
useEffect(() => {
  const id = cursor.currentId
  if (!id) return
  const rec = revealRef.current.get(id)
  if (rec && !rec.scheduler.isLive()) {
    rec.scheduler.goLive(
      (e) => applyFireEvent(rec.noteId, id, e),
      () => {
        cursorDispatch({ type: 'end', activityId: id, at: Date.now() })
        revealRef.current.delete(id)
      }
    )
  }
  tryRevealObserver(id) // §9e
}, [cursor.currentId])
```

Because non-current fires never `goLive`, their content stays buffered — the
one-at-a-time guarantee. A fire whose target note was deleted before its turn
drains as no-ops (the `setNotes` maps find no note), then `done()` fires and
the cursor moves on — no special handling needed.

### 9e. Observer wiring

- **Engine construction** ([App.tsx:1699](apps/web/src/App.tsx)) — wire the
  two new callbacks:
  ```ts
  engine.onContributeStart = () => observerStartRef.current()
  engine.onContributeSettled = (emitted) => observerSettledRef.current(emitted)
  ```
  (Use the same live-ref pattern as `onEmit`/`onLog` so closures aren't
  stale.)
- **On contribute start:** compute a synthetic `activityId = uid('obs')`,
  store it in `pendingObserverRef`, pre-place the future note with the same
  `placeObserverNote(existing, viewport-center-anchor)` call
  `handleObserverEmit` uses ([App.tsx:1665–1673](apps/web/src/App.tsx)),
  dispatch `start` (label `writing`) at that world position.
- **`handleObserverEmit(e)`** ([App.tsx:1665](apps/web/src/App.tsx)) — no
  longer creates the note immediately. Store `heldEmissionsRef.set(activityId,
  e)` (activityId from `pendingObserverRef`), then call
  `tryRevealObserver(activityId)`.
- **`tryRevealObserver(id)`** — no-op unless `id === cursor.currentId` AND
  `heldEmissionsRef` has it. When both hold: build the note exactly as
  `handleObserverEmit` does today (fresh `placeObserverNote`), `setNotes(...)`,
  dispatch `move` to the landed position, dispatch `end`, delete the held
  emission. Called from both the `currentId` effect (9d) and the emit handler
  (covers either arrival order).
- **On contribute settled(emitted):** if `!emitted`, dispatch `end` for the
  pending observer activity and clear `pendingObserverRef` (nothing to draw —
  cursor lingers, fades on schedule). If `emitted`, do nothing here (the note
  reveal drives `end`); as a safety net also call `tryRevealObserver`.

### 9f. Tick + mount

- A 5 s `setInterval` dispatching `{type:'tick', at: Date.now()}` (drives the
  2-min fade). Cheap — the reducer returns the same reference when idle.
- Mount the overlay as a **sibling of `.canvas-layer`, inside `.canvas`**
  (`.canvas` is `position: relative`, [styles.css:370](apps/web/src/styles.css)),
  right after the `.canvas-layer` closing `</div>`
  ([App.tsx:2010](apps/web/src/App.tsx) region):
  ```tsx
  <AiCursorOverlay state={cursor} view={view} />
  ```

---

## 10. Task order

| # | Task | Files | Acceptance |
|---|------|-------|-----------|
| 1 | Types | `ai-cursor-types.ts` | `tsc --noEmit` |
| 2 | Reducer | `ai-cursor.ts` (+ test) | `vitest run src/ai-cursor.test.ts` |
| 3 | Reveal scheduler | `ai-reveal.ts` (+ test) | `vitest run src/ai-reveal.test.ts` |
| 4 | Overlay | `AiCursorOverlay.tsx`, `ai-cursor.css` (+ test) | `vitest run src/AiCursorOverlay.test.tsx`, `tsc --noEmit` |
| 5 | Observer engine hooks | `observer-engine.ts` (+ test) | `vitest run src/observer-engine.test.ts` |
| 6 | App wiring | `App.tsx` | full gate (§11) + supervisor live check |

Tasks 1–5 are independent of App.tsx and safe to build/verify in isolation.
Task 6 is last (it imports all of them) and is where the supervisor reviews
most carefully.

**STOP after Task 6 and hand to the supervisor** for the live walkthrough —
do not tune animation constants or "polish" beyond the spec without asking.

---

## 11. Global validation gate (before reporting done)

From `apps/web/` (confirm the exact scripts in `package.json`):

```bash
npx vitest run      # full suite, including pre-existing tests, all green
npx tsc --noEmit    # no type errors
npm run build       # production build succeeds
```

Report any failure with its output; never report done on red.

**Supervisor's live walkthrough** (not your job, but know what it checks):
single ambient fire shows the cursor + label progression; two fires racing →
second buffers, reveals after the first; zoom/pan keeps the cursor pinned at
constant size with no travel animation; an observer emission materializes its
note only when the cursor arrives; an evaluator-only pass shows nothing; after
~2 min idle the cursor fades (test with a temporarily shortened constant).

---

## 12. Existing-code reference (line numbers as of this plan)

| What | Where |
|------|-------|
| `runAi` (fire lifecycle + stream callbacks) | [App.tsx:915–1093](apps/web/src/App.tsx) |
| Ambient trigger (`void runAi(n.id)`) | [App.tsx:1117](apps/web/src/App.tsx) |
| `firesRef` map | [App.tsx:580](apps/web/src/App.tsx) |
| `patchNote` | [App.tsx:756](apps/web/src/App.tsx) |
| `toWorld` (screen→world) | [App.tsx:831](apps/web/src/App.tsx) |
| `view` transform state | [App.tsx:545](apps/web/src/App.tsx) |
| `handleObserverEmit` | [App.tsx:1665–1687](apps/web/src/App.tsx) |
| Engine construction + `onEmit`/`onLog` wiring | [App.tsx:1699+](apps/web/src/App.tsx) |
| `.canvas-layer` transformed notes layer | [App.tsx:1979](apps/web/src/App.tsx) |
| `[data-noteid]` DOM convention | [App.tsx:1336](apps/web/src/App.tsx) |
| Observer engine cycle (contribute + exits) | [observer-engine.ts:181–300](apps/web/src/observer-engine.ts) |
| `onEmit`/`onLog` callback pattern | [observer-engine.ts:41](apps/web/src/observer-engine.ts) |
| `placeObserverNote` | [observer-placement.ts](apps/web/src/observer-placement.ts) |
| `--accent` token (#ff7a45) | [design-tokens.ts:31](apps/web/src/design-tokens.ts) |
| `.canvas` (position: relative) | [styles.css:370](apps/web/src/styles.css) |
| Cocreate stream event types | [cocreate-types.ts:85](services/llm/cocreate-types.ts) |
```
