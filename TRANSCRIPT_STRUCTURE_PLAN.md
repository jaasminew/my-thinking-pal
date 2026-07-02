# Structured Transcript — Implementation Plan

_Branch: `integrate-transcript`. Owner: Jasmine. Status: approved, implementing._

## Goal

Turn Unit 2's left-panel transcript into a **highly structured, hierarchical
markdown-like document**: distinct topics land in distinct sections, each with a
clear header — instead of one flat wall of cleaned text. The current build never
produced sections even across a clear topic switch; this plan fixes that by
**decoupling instant cleanup from asynchronous structuring**, and by removing the
inline `CONTINUE/NEW_TOPIC` boundary token that defaulted to "never split".

The highlight (`==keyword==` + drag-a-keyword) feature is **removed**. Drag-select
any phrase to the canvas still works.

## Core idea: two decoupled tiers

1. **Cleanup (every 30s)** — a fast, non-thinking-visible pass that rewrites the
   last 30s of raw speech into concise, written-style (书面化) idea lines and
   appends them to the open tail. Low stakes, cheap, frequent.
2. **Segmentation (every 2min + on stop)** — a thinking pass that reads only the
   open tail, decides where topics break, freezes the closed segments with
   headers, and leaves the still-in-progress tail open. Higher latency is fine;
   it runs in the background.

Once a segment is frozen it is **final** — the model never touches it again, so
the layout never flickers. The user can still edit any line/header by hand.

## Data model (`cleanup-engine.ts`, rewritten)

```ts
type Line = { id: string; text: string }              // one cleaned "idea" line
type Section = { id: string; header: string; lines: Line[] }  // frozen

frozenSections: Section[]   // immutable to the model; user may still edit
tail: Line[]                // lines after the last frozen header (open topic)
```

- **A "line" = one idea** emitted by cleanup (one idea per line). Lines are the
  atomic unit of segmentation, so a topic switch **inside** a single 30s cleanup
  is still splittable (split falls between lines, not only between 30s blocks).

## Triggers

- **Cleanup — fixed 30s timer.** Rewrite the raw STT accumulated over the window
  into written-style idea lines; append to `tail`. Empty window → skip silently
  (never an error). Recent tail passed as read-only context so it doesn't restate.
  Model: `gpt-oss-20b` (unchanged).
- **Segmentation — fixed 2min timer.** Send the numbered `tail` to `gpt-oss-120b`
  (thinking, hidden). It returns zero or more closed segments + headers → freeze
  them; the remainder becomes the new open tail. May return none = no split.
- **Stop recording.** Run one final cleanup (flush leftover raw), then one
  segmentation with a `closing` flag so the trailing tail also gets named + frozen
  — every section ends up titled.

## Segmentation contract

Input (only the tail; frozen sections are NOT sent):

```
0: <line text>
1: <line text>
2: ...
```

Output (strict JSON — parsed, never printed to the UI):

```json
{ "sections": [ { "endLine": 2, "header": "..." }, { "endLine": 6, "header": "..." } ] }
```

- `[0..2]` freezes as one section titled by its `header`; `[3..6]` as the next;
  lines after the last `endLine` stay as the new open tail (in progress, unnamed).
- `header` describes the **closed upper** segment: 3–6 words, in the lines'
  language. Multiple splits + multiple headers allowed in one pass.
- No split → `{ "sections": [] }`.
- **No-error guarantees for the thinking model:**
  1. Structural — segmentation output is parsed, never rendered, so leaked
     reasoning can never reach the UI (unlike cleanup, whose content is printed).
  2. Config — `reasoning_format: 'hidden'` + generous `max_tokens (~3000)` so the
     final JSON is never starved.
  3. Fallback — unparseable/empty → treat as no split, retry next cycle, silent.

## File-by-file changes

- **`unit2-canvas-cocreation/src/cleanup-engine.ts`** (rewrite): new state machine
  (`frozenSections` + `tail`), 30s cleanup timer, 2min segmentation timer, stop
  flow; `applySegments()` moves tail lines into `frozenSections`. Remove the old
  `NEW_TOPIC` logic, `liveSection`, and pause-based firing.
- **`server/api-plugin.ts`**:
  - `/api/clean-transcript`: drop `CONTINUE/NEW_TOPIC` and `==highlight==`
    instructions; require "one idea per line, written-style, concise"; empty
    output returns `{ markedText: '', skipped: true }` instead of an error.
  - New `/api/segment`: the contract above; `gpt-oss-120b` + hidden reasoning +
    robust JSON extraction.
  - `getReasoningParams`: return `reasoning_format: 'hidden'` for `gpt-oss-120b`.
- **`services/llm/types.ts` + `client.ts`**: drop `newTopic`; add `requestSegment`
  + its request/result types.
- **`unit2-canvas-cocreation/src/Transcript.tsx`**: render `frozenSections`
  (header + lines) and `tail` (unnamed, current/faint styling); remove keyword
  highlight rendering + drag; keep drag-select; add an English status caption;
  keep double-click-line edit and click-header rename.
- **`unit2-canvas-cocreation/src/App.tsx`**: remove highlight references; record
  start/stop already wired.
- **`unit2-canvas-cocreation/src/styles.css`**: tail vs frozen styling, status
  caption; remove `.kw` highlight styles.

## Status captions (English)

`Listening…` (accumulating) · `Summarizing…` (cleanup in flight) · `Organizing…`
(segmentation in flight).

## Notes / accepted trade-offs

- A single long topic keeps the tail growing; every 2min the whole tail is resent
  to `gpt-oss-120b`. Bounded by topic length, resets on a split. Acceptable.
- Segmentation granularity is line-level (one idea per line), which is effectively
  sentence-level given cleanup emits one idea per line.
