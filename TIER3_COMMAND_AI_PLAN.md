# Tier-3 Command AI Redesign Plan (Revised)

## Goal

Redesign the canvas's explicit command AI so the user can summon AI from selected
content anywhere on the canvas, instead of relying only on the bottom command
box.

The intended interaction:

1. User highlights text in a keyword note.
2. A small AI command bubble appears next to the selection.
3. User asks a question or gives an instruction.
4. A temporary right-side command panel opens.
5. The user can continue chatting with AI in that panel.
6. Any AI-created canvas content remains visually distinct and waiting for
   explicit keep/reject.

This is a user-facing demo, but the technical design should preserve the product
principle: AI extends human thought; it does not silently overwrite it.

## How It Works, Step By Step (Plain-Language Walkthrough)

This is the whole Tier-3 pipeline in beginner terms. Everything later in the
plan is just a more precise version of these eight steps.

**Step 1 — The user selects text.**
Each keyword note already tracks text selections inside itself (that's how
cross-bullet drag-select works today). We add one small thing: when a selection
finishes, the note tells the app "the user selected THIS text, at THIS spot on
the screen."

**Step 2 — A bubble pops up next to the selection.**
The app draws a small floating input box right next to the highlighted text.
Important trick: the moment the bubble appears, we take a *snapshot* of the
selection — the text, which note it came from, and where it was. From then on
we use the snapshot, never the "live" browser selection. Why? Because the
instant the user clicks into the bubble to type, the browser clears its native
selection — that's browser behavior we can't prevent. So we immediately paint
our OWN highlight (pink, like the mock) over the same text, driven by the
snapshot. It stays visible through typing, submitting, and the whole chat, and
only clears when the side panel is officially closed.

**Step 3 — The user types a command and presses Enter.**
The bubble closes, and a chat panel slides in on the right side of the canvas.
The panel shows a small chip with the selected text (so the user can see what
the AI is looking at), the user's question, and an empty assistant reply that
is about to fill in.

**Step 4 — The app sends everything to our own server.**
The browser never talks to an AI model directly. It sends one request to our
dev server (`POST /api/command-chat`) containing: the whole chat history so
far, the highlighted text, everything in the source note so far, and a 1-minute
transcript window around the note — the same kind of context capture the
ambient co-creation call already does. This context is recomputed fresh on
every turn, so if the user adds a bullet mid-conversation, the AI's next reply
sees it. The server holds the keys and knows how to talk to each AI backend.

**Step 5 — The server flattens the chat into one prompt and runs the AI.**
Our AI backends (the `claude` and `codex` CLIs) are "one-shot": each call
starts fresh with no memory. So for every turn, the server pastes the full
conversation history into a single prompt ("User said…, You replied…, User now
says…") and runs the CLI once. The model streams its answer back word by word.

**Step 6 — The server separates "chat text" from "canvas actions".**
The model can only output text. So we teach it a tiny protocol: when it wants
to change the canvas, it writes a special line like
`ACTION: {"type":"insert-bullet","text":"..."}` inside its reply. The server
watches the stream line by line, forwards normal lines to the chat panel as
text, and catches ACTION lines, parses the JSON, and forwards them as
structured action events instead. The user never sees the raw ACTION lines.
(This mirrors how `/api/cocreate` already catches `DIAGNOSIS:` and `ANCHOR:`
lines today.)

**Step 7 — The panel shows the answer; actions become buttons.**
Streamed text appends to the assistant's chat bubble live. Each action arrives
as a labeled button under the reply, e.g. "Add bullet to note". Nothing touches
the canvas yet.

**Step 8 — Clicking an action button creates PENDING content.**
Applying an action inserts content into the note as `origin: 'ai'`,
`status: 'pending'` — gray, with ✓/✕ — exactly like Tier-2 ambient
suggestions. Only when the user clicks ✓ does it become settled canvas content.
So even when the user explicitly asked the AI to do something, the result still
waits for a final human yes.

## Current Relevant Architecture

Active Unit 2 files:

- `canvas-cocreation/src/App.tsx`
- `canvas-cocreation/src/KeywordNoteView.tsx`
- `canvas-cocreation/src/CommandBar.tsx`
- `canvas-cocreation/src/canvas-types.ts`
- `services/llm/cocreate.ts`
- `services/llm/cocreate-types.ts`
- `server/api-plugin.ts`

Current AI paths:

- Ambient co-creation fires from notes after word-count and idle thresholds.
- Explicit bottom `CommandBar` commands call `runAi(noteId, command)`.
- `/api/cocreate` streams NDJSON events.
- AI-generated bullets/cards/images are represented as note items with
  `origin: 'ai'` and `status: 'pending'`.
- Pending AI items render as gray/secondary content with keep/reject controls.

Important existing behavior to preserve:

- Human-authored bullets are always kept.
- AI suggestions remain adjacent, visually distinct, and keep/reject-able.
- Rejected ideas are removed and remembered as negative signals.
- URL cards must come from real search/cited URLs.
- Unit 2 currently uses a custom positioned-note canvas, not tldraw.

Facts the design must respect (verified against the code):

- The AI backends are STATELESS. `claude-code` / `codex` are one-shot CLI
  spawns; `open` is a one-shot HTTP call. There is no server-side session.
- The backends emit PLAIN TEXT only. All structure `/api/cocreate` gets today
  (diagnosis, anchor, cited links) is parsed OUT of the text stream by
  server-side line filters (`makeProtocolFilter`, `makeLinkStripper`).
- Standalone `ImageItem`s in a note render with NO keep/reject controls — they
  were designed as human-dropped, always-kept content. Only bullets and cards
  have pending UI. AI images today attach to a bullet via `BulletItem.image`.
- `KeywordNoteView` owns a custom cross-bullet drag selection and clears its
  paint state on `selectionchange` when the selection collapses or leaves the
  note.
- In-flight AI fires register an `AbortController` in `firesRef`; explicit
  commands bypass the AI on/off toggle (`isCommand` check in `runAi`).
- The workspace is a paper-stack of up to 2 overlapping canvas panels
  (`MAX_OPEN = 2`), each hosting its own `CanvasSpace`.

## Product Model

Tier-2 and Tier-3 should be separate concepts.

Tier-2 ambient co-creation:

- AI quietly reacts to human notes.
- Output lands adjacent to the note.
- Output is short: bullets, cards, images.
- Output is pending until kept/rejected.

Tier-3 command AI:

- User explicitly summons AI from selected context.
- AI behaves like a contextual assistant/chat panel.
- AI can answer questions, reason, search, or propose edits.
- AI may perform canvas actions, but AI-authored results must still be pending
  unless the user explicitly accepts them.

## Core Rule For AI Actions

If the user asks AI to perform an action on the canvas, the action may create
content in the relevant keyword note, but the created content lands as pending
AI content (`origin: 'ai'`, `status: 'pending'`), reusing the exact item shapes
Tier-2 already produces. Only after the user clicks keep does the content
become settled canvas content.

For destructive or overwriting operations, prefer a proposed action with an
explicit confirmation button before changing the canvas. (Out of scope for
demo v1.)

## Selection Snapshot (fixes the bubble-vs-input conflict)

The core rule: **the live browser selection is only used to OPEN the bubble.
Everything after that runs off a frozen snapshot.**

Why: clicking into the bubble's input collapses the browser selection. And
`KeywordNoteView` already clears its own drag-selection paint state on
`selectionchange`. If the bubble's lifetime were tied to the live selection, it
would dismiss itself the moment the user tried to type. So:

1. While the user is selecting, `KeywordNoteView` reports the current
   selection upward (new callback `onTextSelection`).
2. When a non-empty selection settles (pointerup / selection stops changing),
   `CanvasSpace` shows the bubble and freezes a `SelectionSnapshot`.
3. From then on, the bubble and the command session read ONLY the snapshot.
   The browser selection collapsing is expected and ignored.
4. Dismiss is explicit only: Escape, click outside the bubble, or submitting.
   Additionally, any canvas view change (pan/zoom) dismisses the bubble —
   simplest correct behavior for v1, since the snapshot rect is screen-space
   and goes stale when the canvas moves.

```ts
type SelectionSnapshot = {
  noteId: string
  selectedText: string
  // Which items the selection touched (for future replace-selection; unused v1)
  anchorItemId?: string
  focusItemId?: string
  startOffset?: number
  endOffset?: number
  // Screen-space rect of the selection at snapshot time (bubble placement)
  screenRect: { top: number; left: number; width: number; height: number }
}
```

Implementation notes:

- Build on the note's EXISTING selection logic (`onItemsPointerDown`,
  `bulletLocate`, the `selectionchange` effect) — do not add a competing
  global selection system.
- Use `Range.getBoundingClientRect()` for the rect; fall back to the nearest
  bullet rect if the range rect is empty.
- Render the bubble in an overlay OUTSIDE `.canvas-layer` (screen space, so
  pan/zoom transforms never distort it).
- The bubble stops pointer-event propagation so it never starts a note drag or
  canvas marquee.
- One `SelectionSnapshot` type is used everywhere (bubble, session source,
  request context). No parallel rect shapes.

## Persistent Context Highlight

The native browser selection collapses as soon as the bubble input takes
focus — unavoidable. To keep the selected text visibly marked for the whole
conversation, we paint our own highlight from the snapshot.

**Mechanism: CSS Custom Highlight API** (`CSS.highlights.set(...)` +
`::highlight(command-context)` styling — pink, matching the mock).

Why this API and not a wrapper `<span>`:

- It highlights arbitrary text ranges WITHOUT touching the DOM. The bullets
  are contentEditable; injecting spans into them would corrupt editing, the
  caret helpers, and `BulletText`'s text-sync effect.
- The highlight sits on the real text inside the note, so it pans, zooms, and
  moves with the note for free — no screen-space staleness (unlike the bubble
  rect).
- Supported in all current browsers.

Behavior:

- Ranges are rebuilt from the snapshot's item ids + character offsets after
  each render of the source note (React re-renders replace DOM nodes, so
  stored `Range` objects go stale — cheap to rebuild).
- **Lifecycle:** highlight appears when the bubble opens → persists through
  typing, submit, and the whole chat → clears ONLY when the side panel is
  officially closed, or the session is replaced by a new selection.
  Dismissing the bubble WITHOUT submitting (Escape / click-outside) also
  clears it — no session ever started.
- **Edge case (accepted for v1):** if the user edits a highlighted bullet's
  text mid-session, the stored offsets no longer point at the right
  characters. Rule: the highlight drops on that bullet if its text changed;
  the panel's context chip still shows what was selected. (Re-finding the
  text after edits is a later refinement.)

## Client-Side Data Model

One command session at a time per `CanvasSpace` (demo scope). Temporary UI
state — not persisted to localStorage.

```ts
type CommandSession = {
  id: string
  status: 'open' | 'closed'
  source: SelectionSnapshot | null // null = opened from the bottom bar
  title: string
  messages: CommandMessage[]
  createdAt: number
}
```

```ts
type CommandMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  pending?: boolean // assistant message still streaming
  actions?: ProposedAction[]
}
```

```ts
type CommandAction =
  | { type: 'insert-bullet'; noteId: string; text: string }
  | { type: 'append-image'; noteId: string; src: string; sourceUrl?: string; title?: string; caption: string }
  | { type: 'add-card'; noteId: string; title: string; url: string; snippet?: string; image?: string }
  | { type: 'create-note'; keyword: string; bullets: string[] }

type ProposedAction = {
  id: string
  action: CommandAction
  applied?: boolean // button becomes a checkmark once applied
}
```

Deliberately absent in v1: `replace-selection` (destructive; needs a
confirmation flow — deferred entirely), and `sessionId` on the wire (the server
is stateless, so an id would be decoration; the session id lives client-side
only).

## Handling AI Images (fixes the pending-image gap)

Standalone `ImageItem`s have no keep/reject UI, and adding one would fork the
pending model. Instead, reuse the pattern Tier-2 already uses: **an AI image is
always attached to a pending bullet** via `BulletItem.image`.

So the `append-image` action carries a `caption` and applies as:

```ts
{
  kind: 'bullet',
  id: uid('b'),
  origin: 'ai',
  text: action.caption, // short line naming what the image shows
  image: { src: action.src, sourceUrl: action.sourceUrl, title: action.title },
  status: 'pending'
}
```

The image lives and dies with its bullet's ✓/✕ — no new UI, no orphaned
pending images. (Renaming the action to `append-image-bullet` internally is
fine; the wire name stays `append-image`.)

## Multi-Turn Chat Over Stateless Backends

There is no server session. Every turn, the client sends the FULL message
history PLUS freshly captured context; the server flattens both into a single
prompt and makes one fresh backend call:

```txt
[system: command-chat prompt]

Selected text: "..."
Source note:
  keyword: ...
  bullets: ... (human bullets, indentation preserved)
  kept AI ideas: ...
  cards: ...
Transcript window (1 min): "..."

Conversation so far:
User: go search some voice-to-text products
Assistant: Here are three products ...
User: which one is closest to our idea?

Respond to the last user message.
```

**Per-turn context capture — mirrors `runAi`'s capture, with a shorter
transcript window:**

- **Highlighted text** (from the snapshot) — the primary referent.
- **Everything in the source note so far**, same conventions as cocreate:
  keyword; human bullets with indentation preserved; KEPT AI bullets and card
  titles (pending suggestions excluded — they may still be rejected);
  kept/rejected reaction signals.
- **Transcript window, 1 minute TOTAL** (Tier-3 only — Tier-2's windows are
  unchanged): note born from a dragged transcript phrase (`originTs` set) →
  the verbatim ±30s around when it was spoken; otherwise → the rolling last
  60s; nothing recorded → omitted. Same rule-B-beats-rule-A logic as `runAi`,
  halved.
- Context is RECOMPUTED FRESH on every turn, not frozen at session start —
  if the user adds a bullet mid-conversation, the AI's next reply sees it.

Consequences to accept for the demo:

- Each turn re-spawns a CLI (claude/codex), so per-turn latency includes CLI
  startup (~seconds). The panel should show a visible "thinking" state
  immediately so this reads as normal chat latency.
- History grows the prompt each turn. Fine at demo scale; cap or summarize
  later if sessions get long.
- No `sessionId` in the request. If per-turn latency proves painful later, the
  claude CLI's `--resume` could add real sessions — explicitly out of scope
  now.

## Action Protocol (fixes the actions-from-text gap)

This is the riskiest technical piece, so it gets its own contract.

The backends emit plain text only. Structured actions therefore travel INSIDE
the text stream as a line protocol, exactly like `DIAGNOSIS:`/`ANCHOR:` today,
and the server strips them out before the chat text reaches the client.

**Model side (in the command-chat system prompt):** to propose a canvas
action, emit a line that starts with `ACTION:` followed by one single-line
JSON object, e.g.

```txt
ACTION: {"type":"insert-bullet","text":"Wispr Flow focuses on dictation speed over accuracy."}
ACTION: {"type":"add-card","title":"Wispr Flow","url":"https://wisprflow.ai","snippet":"..."}
```

Rules given to the model: one action per line; JSON on the same line; actions
come AFTER the prose answer; at most ~4 actions per reply; card/image URLs must
come from real cited/search results.

**Server side:** a new line filter (sibling of `makeProtocolFilter`) watches
the stream:

- A line starting with `ACTION:` → parse the JSON remainder.
  - Parses and has a known `type` + required fields → emit
    `{ type: 'action', action }` NDJSON event. The server injects the target
    `noteId` from the request context (the model never sees real note ids —
    it can't get them wrong).
  - Malformed JSON or unknown type → drop the line, emit nothing to chat
    (never show the user a broken ACTION line), and log server-side.
- Every other line → normal `{ type: 'text' }` chat streaming.
- Buffer per line before classifying, so a chunk boundary in the middle of
  `ACT|ION:` can't leak half a protocol line into chat (same whole-line
  discipline `makeProtocolFilter` uses).

**Client side:** `action` events append a `ProposedAction` button to the
current assistant message. Actions are NEVER auto-applied in v1 — every action
is a button, even "safe" appends. (One consistent rule is easier to demo and
easier to trust; auto-apply can come later.)

## API Design

```txt
POST /api/command-chat
```

New endpoint, separate from `/api/cocreate` — command chat needs message
history and action proposals; the cocreate prompt's `DIAGNOSIS`/`ANCHOR`/1-3
bullet format would fight a chat panel.

Request:

```ts
interface CommandChatRequest {
  provider: CocreateProvider
  openSub?: OpenSub
  model?: string
  webSearch?: boolean
  messages: { role: 'user' | 'assistant'; text: string }[]
  // Recomputed by the client on EVERY turn (see per-turn context capture)
  context: {
    selectedText?: string
    sourceNoteId?: string // server echoes this back into action noteIds
    sourceNote?: {
      keyword: string
      humanBullets: string[] // indentation preserved (leading spaces, as in cocreate)
      keptAi?: string[] // kept AI bullets + card titles; pending excluded
      kept?: string[] // reaction signals, diagnosis-tagged as in cocreate
      rejected?: string[]
    }
    /** 1 min total: originTs ±30s for dragged notes, else rolling last 60s. */
    transcriptWindow?: string
  }
}
```

Response: NDJSON stream (same transport as `/api/cocreate`).

```ts
type CommandChatEvent =
  | { type: 'text'; text: string }
  | { type: 'action'; action: CommandAction }
  | { type: 'done'; model?: string; provider: CocreateProvider }
  | { type: 'error'; error: string }
```

Server implementation reuses the existing pieces: provider routing
(`runClaude` / `runCodex` / `streamOpenModel`), `readBody`/`json` helpers, the
NDJSON `send` pattern, and `fetchOgImage` for card thumbnails in the search
phase.

## Prompting

New system prompt for command chat. Principles:

- You are a contextual assistant inside a thinking canvas.
- The selected text is the primary referent.
- Answer conversationally first; propose canvas actions only when the user's
  request implies changing the canvas.
- Never overwrite existing content; all canvas output is a proposal.
- Emit actions ONLY via the `ACTION:` line protocol defined above.
- Match the user's language.
- Use web search when the user asks for current products, links, or evidence;
  card URLs must come from real cited/search results.
- Do not expose model reasoning.

Do NOT reuse the cocreate format (`DIAGNOSIS`, `ANCHOR`, 1-3 bullets) — right
for Tier-2, wrong for a chat panel.

## Applying Actions

Application lives client-side next to `setNotes` (a helper used by
`CanvasSpace`). Every applied action produces `origin: 'ai'`,
`status: 'pending'` items:

- `insert-bullet` → append a pending `BulletItem` to the source note.
- `append-image` → append a pending BULLET carrying the image (see "Handling
  AI Images" above) — never a standalone `ImageItem`.
- `add-card` → append a pending `CardItem`.
- `create-note` → new `KeywordNote` positioned in visible canvas space near
  the source note; its generated bullets are pending AI bullets; `keyword`
  itself is settled (the note frame is the container, its content is what's
  pending). Pre-set `lastFiredWords` like `onCommand` does, so the ambient
  every-20 trigger doesn't immediately double-fire on it.

Applying an action marks the `ProposedAction` as `applied` (button → ✓,
disabled) so the same action can't be applied twice.

## Lifecycle, Abort, And The AI Toggle

- Each command-chat request registers an `AbortController` in `firesRef` with
  `isCommand: true` — consistent with existing bookkeeping, and the AI
  on/off toggle's "cancel ambient fires only" behavior stays correct.
- Command chat BYPASSES the AI toggle, matching the existing convention: an
  explicit command is an invitation (`isCommand` check in `runAi`).
- Closing the side panel aborts any in-flight command-chat stream and clears
  the persistent context highlight.
- Opening a new bubble/submitting while a session is open replaces the session
  (demo scope: one session at a time); the old session's highlight is replaced
  by the new one.

## Panel Placement

The side panel renders INSIDE the owning `CanvasSpace` (within `.panel-body`),
pinned to the canvas's right edge — not at workspace level. Reasons:

- Sessions are per-space (they reference that space's notes).
- With two paper-stack sheets open, a workspace-level panel would ambiguously
  overlay the wrong sheet.

The panel overlays the canvas (absolute, right: 0) rather than squeezing it —
no layout reflow of the canvas, and pan still works in the remaining area. If
the hosting sheet is very narrow, the panel caps at ~80% of the sheet width.

## Relationship To Bottom Command Bar

Keep the bottom `CommandBar` for now, but rewire it: submitting opens the same
`CommandSidePanel` with a session whose `source` is null (no selected text)
instead of directly creating a note + calling `runAi`. Note creation then
happens through the same `create-note` action path, so ALL Tier-3 output flows
through one pending-action pipeline. De-emphasize or remove the bar once
inline selection commands feel stable.

## New Files

- `canvas-cocreation/src/InlineCommandBubble.tsx` — floating input at the
  snapshot rect; Enter submits, Escape dismisses, IME-safe (reuse `isImeEvent`),
  stops pointer propagation.
- `canvas-cocreation/src/CommandSidePanel.tsx` — context chip (selected
  text), message list, streaming text, action buttons, input, close button.
- `canvas-cocreation/src/command-session.ts` — `SelectionSnapshot`,
  `CommandSession`, `CommandAction` types; `applyAction` helper; per-turn
  context builder (note state + transcript window → `CommandChatRequest.context`);
  highlight helper (snapshot → `CSS.highlights` ranges).
- `services/llm/command-chat.ts` — client fetch/stream wrapper for
  `/api/command-chat` (same shape as `requestCocreate`).
- Server: new route + action-line filter + command-chat system prompt in
  `server/api-plugin.ts` (or a sibling module if it gets long).

## Implementation Phases

### Phase 1: Selection + Bubble (UI only)

- `onTextSelection` callback from `KeywordNoteView` (built on its existing
  selection logic).
- `SelectionSnapshot` freezing in `CanvasSpace`.
- Persistent context highlight (CSS Custom Highlight API) painted from the
  snapshot the moment the bubble opens.
- `InlineCommandBubble` rendered in a screen-space overlay; dismiss on
  Escape / click-outside / pan / zoom (dismiss-without-submit also clears
  the highlight).

### Phase 2: Panel + Session (mocked AI)

- `CommandSession` state in `CanvasSpace`; panel inside `.panel-body`.
- Submit from bubble (or bottom bar) opens the panel seeded with snapshot +
  first user message.
- Mocked streaming assistant reply + mocked action buttons, wired through the
  real `applyAction` path → pending content appears in the note. The full UX
  is demoable at the end of this phase without a server.

### Phase 3: Server Endpoint (text only)

- `/api/command-chat`: provider routing reused from `/api/cocreate`, history
  flattening, command-chat system prompt, streamed `text` events.
- Client stream wrapper replaces the mock; abort on panel close.

### Phase 4: Action Protocol

- `ACTION:` line filter on the server (parse, validate, inject `noteId`,
  drop malformed lines silently).
- `action` NDJSON events → `ProposedAction` buttons → `applyAction`.
- All four action types, images-as-pending-bullets included.

### Phase 5: Search And Cards

- `webSearch` support in command chat (CLI search instruction / Tavily for
  `open`, as in cocreate).
- Cited/search URLs → `add-card` actions with `fetchOgImage` thumbnails.
- Keep the rule: URL cards only from real cited/search results.

### Phase 6: Polish

- Keyboard: Enter/Escape/IME in bubble and panel input; focus return to the
  note after dismiss.
- Guard against accidental accept: a selection drag that ends on a pending AI
  bullet must not fire its click-to-accept.
- Panel open/close transitions; narrow-sheet width cap; visual QA for pan/zoom
  and bubble placement.

## Risks

- The `ACTION:` protocol depends on model discipline. Mitigations: strict
  line-based parsing, silent dropping of malformed lines, server-injected
  noteIds, and never auto-applying. Worst case, a reply proposes no actions —
  the chat answer still works.
- Selection capture rides on the existing custom cross-bullet selection, which
  is fragile. Mitigation: snapshot-at-open decouples everything downstream
  from live selection behavior; Phase 1 is isolated so this is tested first.
- Per-turn CLI startup latency. Mitigation: immediate "thinking" indicator;
  acceptable for a demo, `--resume` is the later escape hatch.
- Screen-space bubble placement vs pan/zoom. Mitigation: dismiss on view
  change in v1.

## Recommended First Demo Scope

1. Select bullet text → bubble → submit → panel opens → streamed answer.
2. Assistant proposes actions as buttons.
3. Clicking a button appends pending AI content to the source note (or creates
   a new note), with normal ✓/✕.

No replace-selection, no auto-apply, no session persistence. Append-only
pending actions demonstrate the interaction while staying aligned with the
product model.
