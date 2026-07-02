# Thinking Pal — Progress & Handoff Note

**Purpose of this file:** a portable status doc. Hand it to any agent so they know
what we're building, what's decided, and where the work currently stands. Keep it
updated as things change.

_Last updated: 2026-07-01. Owner: Jasmine._

---

## 1. What we're building

**Thinking Pal** — a real-time thinking tool for creators. You speak; live speech
is captured into a continuous transcript; promising ideas ("sparks") get
highlighted; you drag a spark onto an infinite canvas and an AI co-creates on it
with you. It is **not** a meeting notetaker. Core = real-time capture + human/AI
co-creation, low latency, clear separation of human vs AI authorship.

## 2. Immediate goal & deadline

- **Hackathon submission due 2026-07-15.** Requires a **deployed, working web demo
  at a URL**, real end-to-end (not mocked).
- **Next milestone meeting: 2026-07-04 (Sat).**
- Today's focus (Jasmine): connect Unit 1 + Unit 2 into one integrated workflow;
  build the rough architecture of a proactive thinking partner (context management
  + latency management), centered on Unit 2.

## 3. Team split (two parallel tracks)

- **Jasmine — web demo track.** Owns UX correctness + the deployed URL for the
  hackathon. Builds on the existing Unit 1 / Unit 2 web prototypes.
- **Partner — production track.** Owns the scalable **Electron** app + infra.
  Lives on the `electron-client` branch.

The two are **parallel, not waterfall.** They coordinate through a **shared
contract** (`shared-contract/`), not by keeping code in sync. The real handoff
from Jasmine to partner is *validated interaction patterns expressed against that
contract* — the URL is just proof it works. Change the contract only additively
and announce changes (see `shared-contract/README.md`).

## 4. Repo map

- **Branches**
  - `main` — the Unit 1 / Unit 2 web prototypes (the demo's base).
  - `electron-client` — partner's production Electron rewrite (parked for the demo).
  - `integrate-transcript` — **current working branch** (off `main`); Unit 1↔Unit 2
    integration (see §6). Uncommitted as of this writing unless noted.
- **Key directories**
  - `unit1-stt-highlight/` — Unit 1: live STT → cleaned + highlighted transcript.
  - `unit2-canvas-cocreation/` — Unit 2: canvas with keyword notes + AI co-creation.
  - `services/stt/` — pluggable STT providers (Soniox, Speechmatics, iFlytek…).
  - `services/llm/` — LLM client + co-creation calls (browser → `/api/*`).
  - `server/api-plugin.ts` — the backend, currently a **Vite dev-server middleware**
    (see §5 deploy blocker).
  - `shared-contract/` — the cross-track agreement (domain types, provider
    interfaces, `Backend` interface, operation-log projection).

## 5. Architecture essentials

- **Audio:** browser captures mic → connects **directly** to the STT vendor over
  WebSocket, using a short-lived token minted by the backend. Transcript returns
  to the browser.
- **AI:** everything goes through backend routes: `/api/clean-transcript` (cleanup
  + `==highlight==` marking), `/api/highlight` (Tier-1), `/api/cocreate` (Tier-2/3),
  plus `*-key`/token minters for STT.
- **Providers locked for the demo:** **Soniox** (STT, code-switch 中英) + **Groq**
  (all LLM calls) + **Tavily** (web search). The claude/codex **CLI paths in
  `server/agents.ts` cannot run in the cloud** — do NOT use them for the deployed
  demo; use the "open" (Groq) path only.
- **DEPLOY BLOCKER (not yet done):** the backend is a Vite dev middleware
  (`apiPlugin()`), which only exists during `npm run dev`. To get a live URL it must
  be extracted into a real deployable server (recommended: one persistent Node/
  Express server serving the static build + `/api/*`, on Render/Railway/Fly, in a
  US/EU region so Groq/Tavily are reachable without the CN proxy).

## 6. What's done most recently (2026-07-01)

Unit 2's left panel is a working live transcript (branch `integrate-transcript`),
built on an **append-only, sectioned** architecture. Two rounds of work:

### 6a. Base integration (Unit 1 → Unit 2)
- `unit2-canvas-cocreation/src/cleanup-engine.ts` — Unit 1's cleanup + `==highlight==`
  engine, ported in with **latency code removed**.
- `unit2-canvas-cocreation/src/Transcript.tsx` — live Soniox STT feeds the engine;
  cleaned thoughts render with `==marks==` as draggable `.kw` keywords.
- `unit2-canvas-cocreation/src/App.tsx` — start/stop driven by Unit 2's existing
  record button (● bottom of canvas); live transcript fed to the AI as context
  (replaced the static `TRANSCRIPT_TEXT`).

### 6c. Two-tier structured transcript (CURRENT — supersedes 6b, 2026-07-02)

The inline `CONTINUE/NEW_TOPIC` boundary token (6b) never produced sections in
testing — it defaulted to "never split" and overloaded one small model with
clean + highlight + boundary at once. Replaced with a **decoupled two-tier**
design (full spec: `TRANSCRIPT_STRUCTURE_PLAN.md`). **Highlight feature removed**
(drag-select any transcript text to the canvas still works).

- **Cleanup (every 30s)** — `gpt-oss-20b` rewrites the raw window into concise,
  written-style **idea lines (one per line)** appended to an open `tail`. Empty
  output is a silent skip (no more "reasoning/no visible transcript" error).
- **Segmentation (every 2min + on stop)** — `gpt-oss-120b` (thinking, hidden)
  reads ONLY the tail, returns closed segments `{endLine, header}` as JSON. Those
  freeze into titled sections; the still-open topic stays in the tail. Output is
  **parsed, never printed**, so reasoning can't leak to the UI; any failure = "no
  split this round". On stop, a closing pass titles every remaining line.
- Frozen sections are final (model never rewrites them → no flicker); user can
  still hand-edit any line/header. English status caption: `Listening…` /
  `Summarizing…` / `Organizing…`.

**Touched files (6c):** `cleanup-engine.ts` (rewritten — `frozenSections` + `tail`
state machine, 30s/2min timers), `Transcript.tsx` (frozen/tail rendering, no
highlight), `services/llm/{types,client}.ts` (`SegmentRequest/Result`,
`requestSegment`; dropped `newTopic`), `server/api-plugin.ts` (new `/api/segment`
route, cleanup prompt de-highlighted, empty→skip), `styles.css` (tail/status).
**Verified:** typecheck clean (app/service); app mounts, no console errors. NOT
yet exercised with a real mic. ⚠ restart `npm run dev` after server edits.

### 6d. AI co-creation switch (2026-07-02)

Unit 2's ambient co-creation is now a user-controlled mode. A plain switch
labeled "AI co-creation mode" sits at the top-right of the canvas, default ON.

- **OFF** suppresses the ambient every-20-words trigger AND aborts any
  in-flight ambient fire mid-stream (partial suggestion is discarded).
  Tier-3 commands from the command bar still work — explicit ask ≠ ambient.
- **Back ON** resets each note's word-count baseline to its current count, so
  writing done while off never unleashes a burst of stale suggestions.
- Pending AI suggestions already on the canvas stay (awaiting ✓/✕) either way.
- **Context rule change:** only PERMANENT (kept) AI bullets/cards are sent as
  `existingIdeas` to the next model call; pending ones are temporary and excluded.

**Touched files:** `App.tsx` (switch state/UI, abort plumbing, kept-only
existingIdeas), `services/llm/cocreate.ts` + `cocreate-types.ts` (AbortSignal,
`aborted` result), `styles.css` (`.ai-switch`, `.switch`).
**Verified:** typecheck clean on touched files; switch toggles in browser with
no console errors; `/api/cocreate` via **Codex CLI** (logged in, ChatGPT,
model gpt-5.5) returns one bullet in ~7s end-to-end.

### 6e. Ambient co-creation = concrete cases + URLs (2026-07-02)

Redefined what the ambient bullet IS (Jasmine's direction): not an abstract
adjacent idea, but **one inspiration from the internet — a concrete, NAMED
real-world case (product/project/paper) that does what the user is describing,
with a URL card attached most of the time.** Canonical example: user muses
about modular data storage → "- Notion 把页面拆成可嵌套的 block 对象…" + card
linking Notion's block docs.

- `COCREATE_SYSTEM` rewritten: name a real case + how it works (≤25 words, in
  the note's language); abstract idea only as fallback. KEPT/REJECTED steering
  and one-increment rule unchanged.
- Open path: `SEARCH_INSTRUCTION` flipped from "only if helpful" to "almost
  always" — and the SEARCH query must NAME the cited case so the Tavily card
  matches the bullet.
- CLI path (Claude/Codex): model is told to cite the case's name as a markdown
  link. New server-side `makeLinkStripper` (streaming-safe) strips any inline
  markdown/bare links out of the bullet text (canvas renders raw text) and
  converts them to the URL card; a cited link outranks harvested search-result
  links for the single card slot. (Needed because Codex's JSONL doesn't reliably
  expose structured search results.)

**Touched:** `server/api-plugin.ts` only. **Verified:** codex → clean Chinese
bullet naming Notion + matching card; groq+Tavily → bullet naming Trello +
matching card.

### 6b. Append-only + sections + editing (SUPERSEDED by 6c)
The transcript is now an **append-only log**, not one evolving note the model
rewrites. This is the key mental model for any agent touching it:

- **What the model regenerates:** nothing that's already on screen. Each pause
  sends ONLY the new speech chunk; the model returns one cleaned block that is
  **appended** to the current (live) section. Earlier blocks are passed as
  read-only context, never rewritten. **Once a block renders, it is final.**
- **Sections + async headers:** the cleanup reply leads with a `CONTINUE` /
  `NEW_TOPIC` token (parsed server-side into `newTopic`). On `NEW_TOPIC` the live
  section freezes, a separate async `/api/section-header` call titles it (shows
  "titling section…" until it resolves), and a fresh live section starts. Result:
  a stable "sections after sections" layout, headers appearing when a section closes.
- **Editable throughout:** double-click any block → textarea → blur to save; click a
  section header → rename. Edits persist because nothing regenerates. Double-click
  (not single) so single-click + drag-select stay free for the canvas interactions.
- **Highlight robustness:** renderer aliases Markdown `**bold**`/`__bold__` →
  `==highlight==` and strips stray Markdown, so a small model's format slips still
  become draggable keywords. gpt-oss reasoning kept at `low` (medium caused empty
  output + rate-limit pressure). Engine auto-retries on 429 with backoff.

**Touched files (6b):** `cleanup-engine.ts` (rewritten — sections state machine),
`Transcript.tsx` (sections rendering + editing), `services/llm/{types,client}.ts`
(`newTopic`, `requestSectionHeader`), `server/api-plugin.ts` (append-only prompt,
`parseBoundary`, new `/api/section-header` route), `styles.css` (section/header/edit).

**Two interactions preserved (unchanged on the canvas side):**
1. Cursor **drag-select any phrase** → native selection carries `text/plain`.
2. **Drag a highlighted keyword to the canvas** → creates a keyword note with a
   blinking editable bullet to type into.

**Behavior to expect:** panel stays empty *during* speech and fills in *after each
pause* (raw interim STT is deliberately hidden). Blocks append; topic changes add a
divider + retro header; double-click edits stick.

**Verified:** typecheck clean for all touched app/service files; app mounts with no
console errors. **NOT yet exercised with a real mic** (needs Jasmine to speak; keys
in `.env`). ⚠ `server/api-plugin.ts` is a Vite plugin — **restart `npm run dev`**
after any server edit; it does not hot-reload.

## 7. How to run (local)

```bash
npm install
npm run dev          # Vite + the api middleware, on http://localhost:5173
# Unit 1: http://localhost:5173/          Unit 2: http://localhost:5173/unit2.html
```
Requires `.env` with `SONIOX_API_KEY` + `GROQ_API_KEY` (+ `TAVILY_API_KEY` for web
search). Both STT/LLM keys are present in the local `.env`.

## 8. Next steps / open items

- [ ] Test the two-tier transcript (6c) with a real mic end-to-end: 30s cleanup
      appends idea lines, a mid-session topic switch produces a titled section
      within ~2min, closing pass titles the last section on stop, double-click
      edit sticks, drag-select to canvas still works. Restart `npm run dev` first.
- [ ] Tune the 30s / 2min cadence + segmentation prompt sensitivity after seeing
      boundaries live (currently biased to under-split, never chaos).
- [ ] Extract `apiPlugin()` into a deployable server (the §5 deploy blocker).
- [ ] Deploy to a live URL; confirm region reaches Groq/Tavily.
- [ ] Proactive thinking partner: context management + latency management (Unit 2).
- [ ] Polish UX for the demo; add a canned "play sample" fallback for the live demo.
