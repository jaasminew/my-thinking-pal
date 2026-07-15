# Right-Click AI Summon — Implementation Plan

Status: PLANNING — approved spec, not yet implemented.
Owner: Jasmine. Audience: implementer.

---

## 1. Feature summary

Right-clicking anywhere on the canvas (including an empty canvas) opens the existing
inline AI bubble at the cursor. Submitting the bubble opens the existing Tier-3
CommandSidePanel and starts a chat session with **no source note** and the **last
1 minute of raw transcript** (the minute before each send, recomputed per turn)
as context.

The model then routes its own output by user intent:

- **Answer intent** (questions, discussion, temporary asks): the full answer streams
  into the side panel. The model MAY still propose canvas shortcuts (`+ Add …`
  buttons) when the answer contains genuinely keepable insights — same as today.
- **Canvas-write intent** (the user explicitly asks for output ON the canvas:
  "research the AI market and write the key findings in the canvas", "draft the
  outline as notes"): the model's structured output is **auto-applied to the canvas
  as gray PENDING items** (status `'pending'`, origin `'ai'` — the existing ✓/✕
  contract, identical to Tier-2). The panel shows only short prose, e.g. "Done —
  written to the canvas. Let me know if you want to tweak anything." with **no
  proposal buttons**.
- **Follow-up edits**: in later turns of the same session, the model can **edit or
  remove content it created in this session** (and only that content) via new
  edit/remove actions. It can never touch human content, other AI content, or
  anything from a previous session.

Invariants that must not break:

- No AI content ever lands on the canvas as settled. Everything is `pending` until
  the user's ✓.
- The existing selection-summoned bubble flow (select text in a note → bubble →
  panel) keeps working unchanged.
- The existing right-click menu ON a note (Duplicate/Delete) keeps working unchanged.

---

## 2. What already exists (reuse, don't rebuild)

| Piece | Where | State |
|---|---|---|
| Nullable session source (`source: SelectionSnapshot \| null`) | `apps/web/src/command-session.ts:51` | Type supports it; **nothing creates a null-source session today** — this feature is its first caller |
| `openCommandSession(source, firstCommand)` handles `null` | `apps/web/src/App.tsx` (~line 1489) | Works: `sendTurn` skips note context when `cur.source` is null |
| No-source placement for `create-note` (view center) | `App.tsx` `onApplyAction` (~line 1517–1524) | Works; needs the spread rule added |
| Pending/gray item contract (`status: 'pending'`, ✓/✕) | `canvas-types.ts`, `command-session.ts applyAction` | Reuse as-is |
| ACTION/SOURCE streaming protocol + client-side parsing | `services/llm/command-chat.ts` (`handleActionJson`), `packages/core/llm/filters.ts` | Extend with new action types + `apply` flag |
| System prompt | `packages/core/llm/prompts.ts` `COMMAND_CHAT_SYSTEM` | Extend |
| Per-turn prompt assembly | `packages/core/llm/context.ts` `buildCommandChatPrompt` | Extend (transcript label, session-canvas block) |
| Bubble UI | `apps/web/src/InlineCommandBubble.tsx` | Generalize anchor |
| Note right-click menu stops propagation | `App.tsx` `onNoteContextMenu` (~line 1745) | Guarantees no conflict with the new canvas-level handler |

---

## 3. UX spec

### 3.1 Trigger

- `onContextMenu` on the `.canvas` div (`App.tsx` ~line 2246). `e.preventDefault()`
  always (suppress the browser menu on canvas).
- Right-click on a **note** → unchanged (note menu; `onNoteContextMenu` already
  calls `stopPropagation`, so the canvas handler never sees it).
- Right-click on **blank canvas, the dotted background, or a floating canvas
  image** → open the AI bubble at the cursor.
- Works with zero notes on the canvas.
- If a bubble is already open, a new right-click moves it (replace state).
- If a session/panel is already open, the panel stays; submitting the new bubble
  replaces the session (existing `openCommandSession` behavior: aborts the old
  stream).

### 3.2 Bubble

- Same component, same styling, same size (384px). Anchored just below the cursor
  point, clamped into the viewport exactly like today.
- Placeholder copy: EN "Ask AI anything…" / ZH "问 AI 任何问题…" (the
  selection-summoned variant keeps "Ask AI about this… / 向 AI 提问…").
- Dismissal identical to the selection bubble: click outside, Escape, any canvas
  pan/zoom (the wheel handler already clears bubble state — see §4.2).
- Enter / ↑ submits → panel opens, first turn streams.

### 3.3 Panel behavior per intent

- Panel ALWAYS opens on submit, for both intents.
- Answer intent: streamed markdown answer; optional `+ Add …` proposal buttons
  (click-to-apply, unchanged).
- Canvas-write intent: content appears on the canvas progressively as actions
  stream in (gray pending notes/bullets, like a Tier-2 fire). In the panel, each
  auto-applied action renders as an already-applied receipt row (`✓ New note: AI
  market key findings`, disabled) so there is a visible record of what was written,
  followed/preceded by the model's short prose. No actionable buttons.
- Pure completion messages ("Done, let me know…") carry no proposal buttons —
  enforced by prompt (§6.1), not client logic.

### 3.4 Placement / spread rule (multiple created notes)

Anchor = current view center in world coords (existing formula at
`App.tsx` ~1520–1523). For the k-th note created **in one session** (k = 0,1,2…):

```
col = k % 3, row = floor(k / 3)
x = anchor.x + col * 340
y = anchor.y + row * 320
```

340 ≈ note width + gutter (matches the existing "beside the source note" offset);
320 is a reasonable vertical pitch. Track `k` on the session (see §4.3) so notes
created across multiple turns keep flowing in the grid instead of restacking.
Manual button-applied `create-note` in no-source sessions uses the same counter.

### 3.5 Edit scope rule (hard rule)

The model may edit/remove ONLY items that (a) were created by an auto-applied or
button-applied action **in this session**, and (b) are still `status: 'pending'`.
Once the user ✓-keeps an item, it is settled and locked to the model (it disappears
from the editable ledger the model sees). Rejected/deleted items likewise drop out.
Human items and pre-session AI items are never referenced or touchable.

---

## 4. Client changes — `apps/web/src`

### 4.1 Bubble anchor generalization — `InlineCommandBubble.tsx`

Change props from `snapshot: SelectionSnapshot` to:

```ts
{
  anchor: { top: number; left: number; width: number; height: number } // viewport-space
  placeholder: string
  onSubmit: (command: string) => void
  onDismiss: () => void
}
```

Placement math is unchanged (it only reads the rect). Callers:
- selection flow passes `snapshot.screenRect` + the "about this" placeholder;
- right-click flow passes `{ top: e.clientY, left: e.clientX, width: 0, height: 0 }`
  + the "anything" placeholder.

### 4.2 Bubble state — `App.tsx`

Replace `bubbleSel: SelectionSnapshot | null` with a discriminated union:

```ts
type BubbleState =
  | { kind: 'selection'; snapshot: SelectionSnapshot }
  | { kind: 'canvas'; x: number; y: number }
const [bubble, setBubble] = useState<BubbleState | null>(null)
```

Update every current `bubbleSel` touchpoint (all in `App.tsx`):
- wheel/pan/zoom dismiss (~line 973): `setBubble(null)` — unchanged semantics.
- click-outside effect (~line 1368): keyed on `bubble`, unchanged logic.
- highlight effect (~line 1355): `activeSnapshot = session?.source ??
  (bubble?.kind === 'selection' ? bubble.snapshot : null)` — canvas bubbles paint
  no highlight.
- `onNoteTextSelection` sets `{ kind: 'selection', snapshot }`.
- render (~line 2372): map union → `anchor` + `placeholder`; submit calls
  `openCommandSession(bubble.kind === 'selection' ? bubble.snapshot : null, cmd)`.

New handler on the `.canvas` div:

```ts
const onCanvasContextMenu = useCallback((e: React.MouseEvent) => {
  e.preventDefault()
  setNoteMenu(null)
  setBubble({ kind: 'canvas', x: e.clientX, y: e.clientY })
}, [])
```

(Notes never reach it — they stopPropagation. No target filtering needed; floating
images intentionally summon the bubble.)

### 4.3 Session ledger + spread counter — `command-session.ts`

Extend `CommandSession`:

```ts
export type SessionCanvasRef = {
  alias: string          // "n1", "n2", … stable for the session
  noteId: string         // real canvas id — NEVER shown to the model
  /** bullet aliases → real item ids, in creation order: "n1.1" → itemId */
  items: { alias: string; itemId: string }[]
}

export type CommandSession = {
  id: string
  source: SelectionSnapshot | null
  origin: 'selection' | 'canvas'   // NEW — records how the session was summoned
  title: string
  messages: CommandMessage[]
  createdAt: number
  canvasRefs: SessionCanvasRef[]   // NEW — the model-editable ledger
  createdNoteCount: number         // NEW — k for the spread rule (§3.4)
}
```

`origin` is set in `openCommandSession` (new param or derived from the bubble kind).
`canvasRefs`/`createdNoteCount` start empty/0.

Aliases are assigned at APPLY time (auto or button), client-side, and are the ONLY
handles the model ever sees — real ids never enter the prompt (same principle as
the existing "model never sees note ids" rule in `command-chat-types.ts`).

### 4.4 Applying actions — `command-session.ts applyAction` + `App.tsx`

`applyAction` currently returns `KeywordNote[]`. It must now also report what ids it
minted so the ledger can record them. Refactor to:

```ts
export function applyAction(
  notes: KeywordNote[],
  action: CommandChatAction,
  createAt: { x: number; y: number }
): { notes: KeywordNote[]; created?: { noteId: string; itemIds: string[] } }
```

(Or keep the old signature and add a sibling `applyActionTracked` — implementer's
choice; update the existing call site + tests accordingly.)

New action handling (see protocol §5 for shapes). All target resolution happens in
`App.tsx` via the ledger BEFORE calling into pure helpers:

- `insert-bullet` with `ref` (alias of a session-created note) → resolve alias →
  existing `appendToNote` path; register the new bullet in that note's ledger entry.
- `edit-bullet { ref: "n1.3", text }` → resolve to (noteId, itemId); if the item
  still exists AND `status === 'pending'` AND is a bullet → replace its `text`
  (keep id, keep pending). Else drop the action silently (stale ref).
- `remove-item { ref: "n1.3" }` → same resolution + pending guard → remove the item
  from the note. If a note ends up with zero items and an AI-created keyword and no
  human edits, leave the empty note (user can delete); do NOT auto-delete notes in v1.
- `edit-note { ref: "n1", keyword }` → pending-guard variant: only if EVERY item in
  the ledger entry is still pending (i.e., the user hasn't invested in it yet) —
  otherwise drop. Renames the note keyword.
- `create-note` (no ref) → unchanged shape; placement from the spread rule using
  `session.createdNoteCount++`; register `{ alias: `n${refs.length+1}`, noteId,
  items: bulletAliases }`.

Auto-apply wiring in `sendTurn`'s `onAction` handler (`App.tsx` ~1470):

```ts
onAction: (action) => {
  if (action.apply) {
    // resolve refs via sessionRef.current.canvasRefs; mutate notes via setNotes;
    // update ledger + createdNoteCount on sessionRef/setSession;
    // append an APPLIED receipt row to the assistant message:
    patchAsst((m) => ({ ...m, actions: [...(m.actions || []), { id: uid('a'), action, applied: true }] }))
  } else {
    patchAsst((m) => ({ ...m, actions: [...(m.actions || []), { id: uid('a'), action }] })) // unchanged
  }
}
```

Edit/remove actions are ALWAYS auto-applied (they only exist in canvas-write flows);
they get a receipt row with labels from `actionLabel` (§4.7). Button-applied
proposals in no-source sessions must also register in the ledger (so a later "tweak
it" turn can edit them) — route `onApplyAction` through the same ledger-updating
helper.

Guard: auto-apply (`apply: true`) is honored in BOTH session origins, but expected
mainly in `canvas` sessions; validation lives in the shared pending-guard, so a
misfired apply in a selection session is still safe (lands as pending).

### 4.5 Transcript context — `App.tsx sendTurn`

Decision: canvas sessions use the **rolling last 60 s before each send** —
`transcriptSlice(Date.now() - 60_000, Infinity)`, recomputed fresh every turn.
This is EXACTLY the existing null-source branch (~line 1404), so **no code change
is needed here**; verify the branch is hit (canvas sessions have `note ===
undefined`, so the `else` arm applies) and leave the window rules untouched. The
Project-Memory `memoryTask` string (~line 1425) also stays as-is.

No keyword-note context is sent for canvas sessions (automatic: `note` is
undefined). The session-canvas ledger block (§4.6) is the ONLY canvas state the
model sees.

### 4.6 Per-turn context — `command-session.ts buildTurnContext`

Add the model-facing ledger snapshot, rebuilt fresh each turn from live notes:

```ts
ctx.sessionCanvas = session.canvasRefs
  .map((ref) => {
    const note = notes.find((n) => n.id === ref.noteId)
    if (!note) return null                       // user deleted the note → drop
    const lines = ref.items
      .map(({ alias, itemId }) => {
        const it = note.items.find((i) => i.id === itemId)
        if (!it || it.status !== 'pending') return null   // kept/removed → locked, hidden
        return `  [${alias}] ${isBullet(it) ? it.text : isCard(it) ? it.title : '(image)'}`
      })
      .filter(Boolean)
    return `[${ref.alias}] Note "${note.keyword}"${lines.length ? '\n' + lines.join('\n') : ' (no editable lines left)'}`
  })
  .filter(Boolean)
  .join('\n')
```

Signature grows to accept `(note, snapshot, transcriptWindow, session, notes)` —
update both call sites. Type change in `command-chat-types.ts` §5.

### 4.7 Panel rendering — `CommandSidePanel.tsx`

- Receipt rows: `ProposedAction.applied` already renders `✓ + label + disabled` —
  auto-applied actions reuse it verbatim. No new UI needed beyond labels.
- `actionLabel` (`command-session.ts`) gains cases:
  - `edit-bullet` → `Edited: <new text, 40-char ellipsis>`
  - `remove-item` → `Removed a line`
  - `edit-note` → `Renamed note: <keyword>`
  - `insert-bullet` label unchanged.
- The context chip (`session.source?.selectedText`) simply doesn't render for
  canvas sessions (source is null) — no change needed.

---

## 5. Protocol changes — `services/llm/command-chat-types.ts` + `command-chat.ts`

### 5.1 Types

```ts
export type CommandChatAction =
  | { type: 'insert-bullet'; noteId?: string; ref?: string; text: string; apply?: boolean }
  | { type: 'append-image'; noteId: string; src: string; sourceUrl?: string; title?: string; caption: string; apply?: boolean }
  | { type: 'add-card'; noteId?: string; ref?: string; title: string; url: string; snippet?: string; image?: string; apply?: boolean }
  | { type: 'create-note'; keyword: string; bullets: string[]; apply?: boolean }
  | { type: 'edit-bullet'; ref: string; text: string }        // NEW — always applied
  | { type: 'remove-item'; ref: string }                       // NEW — always applied
  | { type: 'edit-note'; ref: string; keyword: string }        // NEW — always applied

CommandChatRequest['context'] += {
  /** Model-editable ledger of THIS session's canvas output, alias-addressed. */
  sessionCanvas?: string
}
```

`ref` is a session alias (`n1`, `n1.3`); `noteId` remains the injected real id for
selection sessions. Exactly one of the two is present after validation.

### 5.2 Validation — `handleActionJson` in `command-chat.ts`

Current gates are `sourceNoteId`-based; extend:

- `insert-bullet` / `add-card`: valid when EITHER `sourceNoteId` exists (inject it,
  as today) OR the raw JSON carries a `ref` string matching `/^n\d+$/` (pass it
  through; the client resolves + pending-guards). Keep text/url checks.
- `create-note`: unchanged + pass through `apply === true` boolean.
- `edit-bullet`: require `ref` matching `/^n\d+\.\d+$/` and non-empty `text`.
- `remove-item`: require `ref` matching `/^n\d+(\.\d+)?$/` — note-level remove is
  NOT allowed in v1; validate to item refs only (`/^n\d+\.\d+$/`).
- `edit-note`: require `ref` `/^n\d+$/` + non-empty `keyword`.
- `apply` passthrough: copy `a.apply === true` onto every emitted action.
- Raise the per-reply action cap from 6 to **10** (research-style canvas writes
  legitimately produce more lines than proposal replies did). Keep the cap; it is
  the runaway guard.
- `append-image` keeps requiring `sourceNoteId` in v1 (image resolution + no-source
  placement is out of scope).

The existing "server injects noteId, model never sees ids" comment must be updated
to describe the alias scheme.

### 5.3 No transport changes

Streaming, `makeCommandActionFilter`, SOURCE handling, local-runtime path: untouched.
New action types flow through the same `ACTION: {json}` lines.

---

## 6. Prompt changes — `packages/core/llm`

### 6.1 `prompts.ts` — `COMMAND_CHAT_SYSTEM`

Rework the framing + add the routing/editing contract. Required content (implementer
writes final prose, keep style/length discipline of the existing prompt):

1. Framing: the user may summon you from selected text OR from anywhere on the
   canvas; in the latter case there is no selected text and no source note, and you
   receive the last minute of the user's spoken transcript.
2. Intent routing:
   - Default: answer in the panel. Concise, conversational (existing rules stand).
   - When the user EXPLICITLY asks for output written onto the canvas ("write … in
     the canvas", "create notes for …", "draft … as notes"), do the work via ACTION
     lines with `"apply": true`, and keep prose to a short completion message
     ("Done — I've written 3 notes on the canvas. Want any tweaks?"). Do NOT repeat
     the written content in prose. Do NOT add extra proposal actions after a
     completed write.
   - When merely answering, you may still attach up to a few NON-apply proposal
     actions if (and only if) the answer contains insights worth keeping. A pure
     status/completion message gets zero actions.
3. Editing contract: "Canvas content you created this session" arrives as an
   alias-addressed list (`[n1]`, `[n1.2]`). To revise, emit
   `ACTION: {"type":"edit-bullet","ref":"n1.2","text":"…"}`,
   `ACTION: {"type":"remove-item","ref":"n1.2"}`,
   `ACTION: {"type":"edit-note","ref":"n1","keyword":"…"}`,
   or `insert-bullet`/`add-card` with `"ref":"n1"` to extend one of your notes.
   Only listed aliases are editable; everything else on the canvas is read-only to
   you. Lines the user has accepted disappear from the list — never try to edit them.
4. Everything you write lands gray/pending and the user accepts or rejects it —
   never claim content is final.

### 6.2 `context.ts` — `buildCommandChatPrompt`

- Transcript label: replace the hardcoded `"Spoken transcript around this note
  (1 min)"` with a variant chosen by presence of `sourceNote`: no source note →
  `"Spoken transcript (last 1 min):"`; with source note → existing label.
- Append the ledger block when `context.sessionCanvas` is non-empty:

  ```
  Canvas content YOU created this session (alias-addressed; the only canvas content you may edit):
  <sessionCanvas>
  ```

- When there is neither a source note nor selected text, add one orientation line:
  `"The user summoned you from the open canvas — no note is selected."`

Update `context.test.ts` snapshots/cases (§8).

---

## 7. Flow walkthrough (for the implementer's mental model)

Turn 1 — user right-clicks empty canvas, types "research the AI-agent market and
write key findings on the canvas":

1. `onCanvasContextMenu` → `setBubble({kind:'canvas', x, y})`.
2. Submit → `openCommandSession(null, cmd)` with `origin:'canvas'` → panel opens,
   `sendTurn` fires with the last-60s transcript, no note context, empty
   `sessionCanvas`.
3. Model streams short prose + `ACTION: {"type":"create-note","keyword":"AI agent
   market — key findings","bullets":[…],"apply":true}` ×3.
4. Each action auto-applies on arrival: notes appear gray at view-center grid
   (k = 0,1,2), ledger gains `n1..n3` with bullet aliases, panel shows three ✓
   receipt rows + "Done — let me know if you want tweaks."

Turn 2 — user types "merge the second and third notes, shorter bullets":

5. `buildTurnContext` rebuilds `sessionCanvas` from live pending items.
6. Model emits `edit-bullet`/`remove-item`/`insert-bullet ref:"n2"`/`edit-note`
   actions; each resolves through the ledger with the pending guard and applies;
   receipts appear in the panel.

Any turn — user ✓-keeps a bullet → it leaves the ledger view next turn; model can
no longer edit it. User closes panel → session over; a NEW right-click session
starts with an empty ledger and cannot edit the previous session's leftovers
(they remain ordinary pending items the user settles by hand).

---

## 8. Tests

- `packages/core/llm/context.test.ts`: transcript-label variants; sessionCanvas
  block rendering; no-note orientation line.
- `services/llm/command-chat.test.ts`: `apply` passthrough; ref-based
  `insert-bullet`/`add-card` accepted without `sourceNoteId`; `edit-bullet` /
  `remove-item` / `edit-note` shape validation (bad refs rejected); cap = 10;
  `append-image` still requires `sourceNoteId`.
- `apps/web/src/command-session` tests (new): `applyAction` tracked-ids return;
  ledger registration; edit/remove resolution incl. pending guard (kept item →
  action dropped), stale ref (item deleted) → no-op; spread-rule coordinates for
  k = 0..4 across two turns.
- App-level (pattern of existing tests): canvas right-click opens bubble (and not
  on a note); submit opens a `canvas`-origin session; wheel dismisses the canvas
  bubble; auto-applied action renders an applied receipt row.
- Manual verify checklist: empty canvas ask-question flow; canvas-write flow with
  streaming progressive appearance; tweak turn; ✓-keep then attempt edit; browser
  context menu suppressed on canvas but intact in panel/transcript/sidebar.

---

## 9. Explicitly OUT of scope (v1)

- Table/spreadsheet canvas element (bullets-in-notes is the only structured output).
- Any transcript window beyond the rolling last 60 s (full-session transcript was
  considered and rejected for per-turn cost).
- `append-image` in no-source sessions.
- Note-level `remove` action; auto-deleting emptied notes.
- Editing content from previous sessions or human content — permanently out by rule.
- Session persistence across reload (ledger dies with the in-memory session,
  matching current session behavior).

## 10. Decisions already made (do not re-open during implementation)

- Model routes intent itself via per-action `"apply": true`; no separate classifier.
- Panel always opens; auto-applied actions render as disabled ✓ receipt rows.
- Edit scope = this session's items, pending-only; kept = locked.
- Action cap 10; aliases client-assigned; real ids never reach the model.
- Transcript context = rolling last 60 s before each send (the existing
  null-source rule), recomputed per turn.
- Spread rule: 3-column grid, 340×320 pitch, session-persistent counter.
