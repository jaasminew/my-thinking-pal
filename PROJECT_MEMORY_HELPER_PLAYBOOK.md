# Project Memory — Helper Agent Playbook

You are the **implementer** for the Project Memory feature. This file is your
complete instruction set. A separate lead agent ("the Lead") owns the design,
the retrieval brain, and all prompt/integration wiring. Your job is to build the
well-specified, self-contained pieces in the exact order below.

**Read this whole file before touching any code.**

---

## 0. Golden rules

1. **Do not plan or redesign.** Implement exactly what each task specifies. If a
   task is ambiguous or a needed type/signature is missing, **STOP and ask the
   Lead** — do not guess or invent an interface.
2. **Work in queue order.** Do H1, then H2, … through H7. Do not skip ahead or
   reorder.
3. **Respect the STOP gates** (Section 2). The most important one: do not start
   anything until the contract file exists.
4. **Never touch Lead-owned files** (Section 5). If a task seems to require
   editing one, stop and ask.
5. **Do not wire anything into the app.** You build components and modules in
   isolation. The Lead connects them to `App.tsx`, `Sidebar.tsx`, `CanvasSpace`,
   `runAi`, and `sendTurn`. Building a component is yours; mounting it is not.
6. After each task, run its **Acceptance check**, then report "Hn done" with a
   one-line summary and move to the next task.

---

## 1. What we're building (context only — do not act on this section)

Users upload project documents (PRDs, notes, etc.). Before an AI call, the model
is shown a **catalog** of just each file's title + description and picks which
files it wants. The picked files are then **released whole** into the AI's
context (no embeddings, no chunk search). A size guard truncates oversized files.

Locked numbers you will need:

| Guard | Value |
|---|---|
| Max upload size | 20 MB per file |
| Stored extracted text cap | 250,000 characters |
| Per-file injection cap | 8,000 tokens (~6,000 words) |
| Total per-call injection budget | 12,000 tokens |
| Max files the model may select | 4 |

You mostly store and parse. The Lead applies the caps during retrieval. Where a
task needs a cap (e.g. extraction char cap), it is stated explicitly.

---

## 2. STOP gates — when to wait for the Lead

- **GATE A (start):** Do not begin H1 until the contract file
  `services/project-memory/types.ts` exists AND contains a header comment line
  `// CONTRACTS FROZEN — F1`. That file, plus the route table in
  `PROJECT_MEMORY_CONTRACTS.md` (root), define every type, function signature,
  and API route you must implement. If either is missing or lacks a signature a
  task needs, **STOP and ask the Lead.**
- **GATE B (end):** After H7, **STOP.** Do not integrate, wire, or mount
  anything. Report "H-queue complete" and wait. The Lead does all integration.
- **Ad-hoc stop:** Any time the contract doesn't cover what a task needs, stop
  and ask rather than improvising.

You are never blocked mid-queue: H1–H7 depend only on the frozen contracts and
on each other in the given order. Just run them top to bottom.

---

## 3. The task queue

For every task: implement the signatures from the contract exactly, add unit
tests for pure logic, and do not edit anything outside the listed files.

### H1 — Local store (IndexedDB)

- **Create:** `services/project-memory/local-store.ts`
- **Goal:** Implement the local (signed-out) persistence layer against the
  `LocalStore` interface defined in `types.ts`. Store file metadata, instructions,
  original blobs, and extracted text in IndexedDB. **Never** put blobs in
  `localStorage`.
- **Implement:** every method in the `LocalStore` interface — create/list/get/
  delete file, get/put instructions, put/get extracted text, put/get blob.
  Key records by `(scopeKind, scopeId)` exactly as the interface specifies.
- **Do not** call any AI, generate titles/descriptions, or do retrieval. This is
  dumb storage only.
- **Acceptance:** unit test (fake-indexeddb) — create a file, list it, store +
  read back text and blob, delete it, and confirm instructions round-trip per
  scope.

### H2 — Browser text extraction

- **Create:** `services/project-memory/ingestion.ts`
- **Goal:** Pure functions that turn a `File`/blob into plain text for the simple
  formats: `.txt`, `.md`, `.csv`, `.json`. Implement the `extractTextBrowser`
  signature from `types.ts`.
- **Behavior:** decode as UTF-8; for CSV/JSON return the raw text (no parsing
  cleverness needed); truncate output to 250,000 chars and set a `truncated`
  flag. Unsupported types return `{ ok: false, reason: 'unsupported' }` — never
  throw.
- **Do not** attempt PDF/Office here (that is H7, backend).
- **Acceptance:** unit tests for each supported type + one unsupported type + the
  truncation boundary.

### H3 — Project Memory modal (presentational only)

- **Create:** `apps/web/src/ProjectMemoryModal.tsx`
- **Goal:** A pure, props-driven modal component. It renders; it does **not**
  fetch, store, or wire itself into the app.
- **Props:** take exactly the `ProjectMemoryModalProps` shape from `types.ts`
  (files, instructions, status flags, and callbacks `onUpload`, `onDeleteFile`,
  `onRetryFile`, `onSaveInstructions`, `onClose`).
- **Sections:**
  1. *Knowledge base* — drop zone; file rows showing icon, title, description,
     status (`queued`/`extracting`/`indexed`/`failed`), size, delete; a failed
     row shows retry + delete.
  2. *Project instructions* — a segmented control with three tabs (Transcription
     summary, AI co-creation, AI command), a textarea per tab, and a visible
     saved-state indicator.
- **Style:** match the existing hand-drawn stroke-icon chrome used in
  `Sidebar.tsx` (reuse the `icon(...)` pattern; do not import a UI library).
- **Do not** import `App`, call backends, or add it to any parent. Export the
  component only.
- **Acceptance:** render test with mock props — file rows render, failed row
  shows retry, switching tabs swaps the textarea, callbacks fire on click.

### H4 — Backend API client

- **Create:** `services/project-memory/client.ts`
- **Goal:** A thin `fetch` wrapper implementing the `MemoryClient` interface from
  `types.ts`, calling the routes listed in `PROJECT_MEMORY_CONTRACTS.md`. Upload
  uses `multipart/form-data`.
- **Behavior:** attach the auth header the same way existing service calls do
  (follow the pattern in `services/llm/client.ts`); surface non-2xx as a typed
  error; no retries, no caching.
- **Do not** do retrieval or any AI selection — this is transport only.
- **Acceptance:** unit tests with a mocked `fetch` verifying method, URL, headers,
  and body shape for each route.

### H5 — Backend storage (Go / SQLite)

- **Edit:** `server-go/internal/storage/store.go` (add interface methods),
  `server-go/internal/storage/sqlite/` (implement), and add the SQLite table
  DDL where the existing migrations/table creation lives.
- **Goal:** Persist project-memory files, extracted text, and instructions. Use
  the table definitions from `PROJECT_MEMORY_CONTRACTS.md`. Add store methods:
  create/list/get/delete file (scoped by `owner_id, scope_kind, scope_id`),
  put/get instructions, put/get extracted text, put/get blob path.
- **Rules:** every query filters by `owner_id` (no cross-user reads). Delete
  cascades a file's text. Model this on the existing `documents` store methods.
- **Do not** call any AI or generate metadata. Storage only.
- **Acceptance:** Go tests — create+list+delete file, instructions save/load by
  scope, and a cross-user access attempt returns not-found/denied.

### H6 — Backend HTTP handlers + routes

- **Create:** `server-go/internal/projectmemory/handler.go` (mirror the shape of
  `internal/documents/handler.go`).
- **Edit:** `server-go/internal/httpapi/router.go` to register the routes.
- **Goal:** Implement the authenticated routes from the contract:
  list, upload (multipart → store blob + extracted text + metadata the client
  supplied), delete, get text, get/put instructions.
- **Rules:** upload persists the original blob and the client-provided
  title/description/extracted-text; it does **not** generate anything with AI.
  Enforce the 20 MB limit and reject oversized uploads with a clear error.
  Guard Office/zip extraction against decompression bombs (cap decompressed size).
- **Depends on H5.**
- **Acceptance:** handler test — upload creates metadata, list returns it, delete
  removes it, oversized upload is rejected, unauthenticated request is refused.

### H7 — Server-side text extraction

- **Create:** `server-go/internal/projectmemory/extract.go`
- **Goal:** Pure Go functions: bytes + mime → plain text for `.pdf`, `.docx`,
  `.pptx`, `.xlsx`. PDF via a text-extraction lib (or `pdftotext` if present);
  DOCX/PPTX by unzipping Office XML and pulling text; XLSX via `excelize`.
- **Rules:** cap decompressed input and output text at the 250k-char limit; on any
  failure return `("", err)` so the caller can mark the file `failed` — never
  panic. If a format's lib isn't wired yet, return a clear "unsupported in this
  build" error rather than a fake success.
- **Acceptance:** table-driven test with a small fixture per format asserting
  non-empty extracted text; a corrupt-file fixture returns an error, not a panic.

---

## 4. Coordination protocol

1. At start, verify **GATE A**. If not satisfied, post: "Blocked on F1 contracts"
   and wait.
2. Run H1→H7 in order. After each: run its acceptance check; if green, report
   `Hn done — <one line>`; if red, fix; if blocked on a missing contract, stop
   and ask.
3. At **GATE B** (after H7), post "H-queue complete" and wait for the Lead. Do not
   start integration.
4. If the Lead posts a revised contract mid-queue, re-read `types.ts` and
   `PROJECT_MEMORY_CONTRACTS.md` before continuing.

---

## 5. Files you must NEVER edit (Lead-owned)

Touching these will collide with the Lead's parallel work. If a task appears to
need one, **stop and ask.**

- `services/project-memory/retrieve.ts` — retrieval brain / Stage-A selection
- `packages/core/llm/prompts.ts` and `packages/core/llm/context.ts`
- `services/llm/cocreate.ts`, `services/llm/command-chat.ts` (prompt assembly)
- `apps/web/src/App.tsx` (esp. `runAi`, `sendTurn`)
- `apps/web/src/signal-engine.ts`
- `apps/web/src/Sidebar.tsx` and any `CanvasSpace` mounting/wiring
- `services/project-memory/types.ts` — **read-only for you.** The Lead owns it.

---

## 6. Validation before reporting the queue complete

```bash
npm test
npm run build
cd server-go && make test
```

All three must pass. Report failures with the output; do not report "done" on red.
