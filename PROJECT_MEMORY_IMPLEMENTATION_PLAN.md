# Project Memory Implementation Plan

Project Memory adds two project-scoped capabilities:

- Project Knowledge Hub: user-uploaded files that become retrievable context for AI calls.
- Project-Level Instructions: custom instructions for transcription summary, AI co-creation, and AI command flows.

This feature should be implemented as project context, not note context. A canvas inherits memory from its parent project. A root-level canvas gets an implicit memory bucket keyed by its own space id, preserving current behavior for canvases outside projects.

## Product Constraints

- AI extends and structures human thought; it must not overwrite human-authored content.
- Output language should continue to match the user's dominant spoken or written language.
- AI suggestions remain adjacent, visually distinct, and keep/reject-able.
- Project memory is dynamic context. It should inform the model, not become visible canvas content unless the user accepts an AI suggestion or action.
- Project-level instructions are appended after the system prompt and before dynamic project information.

## Data Model

Add project memory entities separate from canvas CRDT data.

```ts
type ProjectMemoryScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'space'; spaceId: string }

type ProjectMemoryFile = {
  id: string
  scopeKind: 'project' | 'space'
  scopeId: string
  name: string
  mimeType: string
  size: number
  title: string
  description: string
  status: 'queued' | 'extracting' | 'indexed' | 'failed'
  error?: string
  createdAt: string
  updatedAt: string
}

type ProjectInstructions = {
  transcriptionSummary: string
  coCreation: string
  aiCommand: string
}

type MemoryChunk = {
  id: string
  fileId: string
  ordinal: number
  heading?: string
  text: string
  tokensApprox: number
  embedding?: number[]
}
```

Keep metadata and instructions in the Go backend when signed in. For local-only mode, store metadata, instructions, extracted text, and embeddings in IndexedDB. Do not store uploaded file blobs in `localStorage`.

## Backend Storage

Extend `server-go` with SQLite-backed project memory tables.

```sql
CREATE TABLE IF NOT EXISTS project_memory_files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  blob_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_memory_scope
  ON project_memory_files(owner_id, scope_kind, scope_id);

CREATE TABLE IF NOT EXISTS project_memory_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  heading TEXT,
  text TEXT NOT NULL,
  tokens_approx INTEGER NOT NULL,
  embedding_json TEXT,
  FOREIGN KEY(file_id) REFERENCES project_memory_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_memory_chunks_file
  ON project_memory_chunks(file_id, ordinal);

CREATE TABLE IF NOT EXISTS project_instructions (
  owner_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  transcription_summary TEXT NOT NULL DEFAULT '',
  co_creation TEXT NOT NULL DEFAULT '',
  ai_command TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, scope_kind, scope_id)
);
```

Add authenticated API routes:

```txt
GET    /project-memory/{scopeKind}/{scopeId}
POST   /project-memory/{scopeKind}/{scopeId}/files
DELETE /project-memory/files/{fileId}
GET    /project-memory/files/{fileId}/text
POST   /project-memory/{scopeKind}/{scopeId}/retrieve

GET    /project-memory/{scopeKind}/{scopeId}/instructions
PUT    /project-memory/{scopeKind}/{scopeId}/instructions
```

The upload endpoint should accept `multipart/form-data`, persist the original blob, extract text, generate title and description metadata, chunk the text, embed chunks when embedding support is configured, then mark the file as `indexed`.

## File Ingestion

Supported tiers:

Tier 1:

- `.txt`, `.md`, `.csv`, `.json`
- PDF text extraction
- `.docx`
- `.xlsx`
- `.pptx`
- `.html`

Tier 2:

- `.jpg`, `.jpeg`, `.png`
- OCR or vision-model description extraction
- Image metadata and embedded text when available

For the Go backend:

- PDF: use a text extraction library or `pdftotext` if available in the deployed environment.
- DOCX/PPTX: unzip Office XML and extract text from documents and slides.
- XLSX: use an Excel parser such as `excelize`.
- Images: start with an OCR or vision abstraction. If unavailable, store filename, dimensions, and an "image content unavailable" extraction record rather than failing the upload.

For local-only browser mode:

- Support plain text, markdown, JSON, and CSV directly.
- Support images as metadata only unless OCR is added.
- Show unsupported file status clearly.

The proper broad-file RAG path should rely on backend ingestion.

## RAG Flow

Use progressive disclosure in two stages.

### Stage A: File Selection

Before each AI call, build a compact file catalog:

```txt
Project knowledge base:
[pmf_1] Title: Launch PRD
Type: PDF
Description: Product requirements for onboarding, pricing, activation metrics.

[pmf_2] Title: Customer interview notes
Type: DOCX
Description: Pain points from creator workflow interviews.
```

Ask the model to select relevant files and optional retrieval queries as strict JSON:

```json
{
  "files": [
    { "id": "pmf_1", "query": "activation metrics onboarding constraints" }
  ]
}
```

This selection call should be cheap and capped. It should receive the current user task, note context, transcript window, signal window, and file catalog, but not full file contents.

### Stage B: Chunk Retrieval

For selected files:

- Run vector search over chunks filtered to the selected file ids.
- Run lexical fallback using the selected query.
- Return a capped number of excerpts, usually 4-8 chunks total.
- Cap token budget by role:
  - Transcription summary: instructions only initially.
  - AI co-creation: about 1200-2000 tokens.
  - AI command: about 2000-3000 tokens.
- Include stable citation labels such as file title and chunk id.

Final dynamic context order:

```txt
Project knowledge available:
<file catalog>

Relevant project memory excerpts:
[Launch PRD / chunk 4]
...

Transcript/signals:
...

Canvas note/context:
...
```

This keeps project knowledge before transcript and keyword note, while only disclosing relevant excerpts.

## AI Prompt Integration

Modify request contracts:

- `CocreateRequest`
  - `projectInstructions?: string`
  - `projectMemory?: ProjectMemoryContext`
- `CommandChatRequest`
  - `projectInstructions?: string`
  - `projectMemory?: ProjectMemoryContext`
- `ExtractSignalsRequest` and organize inputs
  - `projectInstructions?: string`

Add helpers in `packages/core/llm/context.ts`:

```ts
buildProjectMemoryCatalog(...)
buildProjectMemoryExcerpts(...)
prependProjectMemoryContext(...)
```

System prompt handling should follow this order:

```ts
const system =
  baseSystem +
  formatProjectInstructions(req.projectInstructions) +
  searchInstruction
```

For transcript summary:

- Append `instructions.transcriptionSummary` to `EXTRACT_PROMPT`.
- Also append it to organize prompts if it affects sectioning or naming.
- Do not include knowledge hub excerpts in routine transcript extraction initially. It risks biasing the transcript summary away from what was actually spoken.

For co-creation:

- Append `instructions.coCreation` after `COCREATE_SYSTEM`.
- Add selected memory excerpts before transcript and signals.

For AI command:

- Append `instructions.aiCommand` after `COMMAND_CHAT_SYSTEM` or `COMMAND_SYSTEM`.
- Add selected memory excerpts before selected text, note context, and transcript.

## Frontend UI

Create `apps/web/src/ProjectMemoryModal.tsx`.

Modal sections:

1. Project knowledge base
   - Drop zone
   - Upload progress and status
   - File rows with icon, title, description, status, size, and delete action
   - Failed extraction row with retry and delete actions
   - Optional extracted text preview in a later pass

2. Project-level instructions
   - Segmented control or tabs:
     - Transcription summary
     - AI co-creation
     - AI command
   - Textarea for each role
   - Explicit save or debounced save with visible saved state

Open paths:

1. Sidebar project row
   - In `apps/web/src/Sidebar.tsx`, add a toolbox icon button visible on hover for project rows.
   - Stop propagation so clicking the icon opens the modal without selecting or renaming the row.
   - Add prop: `onOpenProjectMemory(node: TreeNode)`.

2. Canvas top right
   - In `CanvasSpace`, add a toolbox icon to the right of the AI co-creation switch.
   - Pass scope from `App`: parent project if the active canvas is inside a project, otherwise `{ kind: 'space', spaceId }`.

Add scope utilities:

```ts
findParentProject(tree, spaceId)
memoryScopeForSpace(tree, spaceId)
```

## Client State Layer

Add a new service area:

```txt
services/project-memory/
  types.ts
  local-store.ts
  client.ts
  retrieve.ts
  ingestion.ts
```

Responsibilities:

- `client.ts`: backend API wrapper.
- `local-store.ts`: IndexedDB local-only implementation.
- `retrieve.ts`: catalog building and retrieval orchestration.
- `ingestion.ts`: browser fallback extraction.

Add a React hook:

```ts
useProjectMemory(scope, backend)
```

Return shape:

```ts
{
  files,
  instructions,
  uploadFiles(files),
  deleteFile(id),
  saveInstructions(next),
  retrieveForCall(role, queryContext)
}
```

`CanvasSpace` should either receive `memoryScope` and project-memory service methods from `App`, or receive callbacks such as `openMemoryModal(scope)` and `getMemoryContext(role, input)`.

## Retrieval Call Placement

Ambient co-creation:

```ts
const memory = await retrieveProjectMemory({
  role: 'coCreation',
  scope,
  seed,
  contextNotes,
  transcriptWindow,
  signalWindow
})
```

Call this inside `runAi`, before `requestCocreate`.

Command chat:

```ts
const memory = await retrieveProjectMemory({
  role: 'aiCommand',
  scope,
  selectedText,
  sourceNote,
  transcriptWindow,
  userMessage: text
})
```

Call this inside `sendTurn`, before `requestCommandChat`.

Transcript:

- When constructing `SignalEngine`, pass project instructions into config.
- If instructions change, update `engineRef.current.config.systemPrompt`.
- Avoid retrieving knowledge excerpts for every STT extraction at first because it adds latency, cost, and bias risk.

## Embeddings

Do not make embeddings provider-specific inside UI code. Add a small abstraction:

```ts
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
}
```

Backend options:

- Use configured OpenAI-compatible embeddings if available.
- Use lexical fallback initially when no embedding provider is configured.
- Store `embedding_json` in SQLite for MVP.
- Later move to sqlite-vss, pgvector, or a dedicated vector database.

Retrieval scoring:

- Vector similarity.
- Lexical overlap.
- Title and description boost.
- Recency boost.
- Per-file cap so one large PRD does not dominate all results.

## Tests

Frontend and core tests:

- Scope resolution from tree.
- Instruction serialization.
- Prompt assembly order.
- File catalog formatting.
- Retrieval result capping.
- Selected-file JSON parsing robustness.
- Command and co-creation requests include memory context.

Backend tests:

- Upload creates file metadata.
- Delete cascades chunks.
- Instructions save and load by owner and scope.
- Retrieve denies cross-user access.
- Unsupported file produces `failed` status without crashing.

Validation before handoff:

```bash
npm test
npm run build
cd server-go && make test
```

## Recommended Phasing

### Phase 1: UI and Instructions

- Modal.
- Sidebar and canvas toolbox entry points.
- Persist project-level instructions.
- Inject instructions into transcription summary, co-creation, and command prompts.

### Phase 2: Knowledge Hub Metadata and Local Text Files

- Upload/list/delete.
- Plain text, markdown, CSV, and JSON extraction.
- Catalog disclosure.
- Retrieval context insertion with lexical search.

### Phase 3: Backend Ingestion

- Multipart upload APIs.
- SQLite metadata and chunks.
- PDF, DOCX, XLSX, and PPTX extraction.
- Signed-in sync across devices.

### Phase 4: Proper RAG

- Embeddings.
- Model-driven file selection.
- Chunk retrieval from selected files.
- Token budgets and citations.

### Phase 5: Images

- OCR or vision extraction.
- Image summaries as chunks.
- Optional visual preview in the modal.

