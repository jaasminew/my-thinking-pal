# Project Memory — Frozen Contracts (F1)

Companion to `services/project-memory/types.ts` (`// CONTRACTS FROZEN — F1`).
This file freezes the backend half: SQLite DDL, the authenticated route table,
and the Go store-method signatures. Helper tasks H4–H7 implement exactly this.

The server is a **dumb store**: it never calls AI, never holds an LLM key. The
only compute it does is deterministic text extraction (PDF/Office) at upload.

---

## 1. SQLite DDL (H5)

Append to the `schema` constant in `server-go/internal/storage/sqlite/sqlite.go`
(same `CREATE TABLE IF NOT EXISTS` style as the existing tables). **No chunk or
embedding tables.**

```sql
CREATE TABLE IF NOT EXISTS project_memory_files (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  scope_kind  TEXT NOT NULL,            -- 'project' | 'space'
  scope_id    TEXT NOT NULL,
  name        TEXT NOT NULL,            -- original filename
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,         -- original blob bytes
  title       TEXT NOT NULL,            -- client-provided (browser AI or fallback)
  description TEXT NOT NULL,            -- client-provided
  status      TEXT NOT NULL,            -- queued|extracting|indexed|failed
  error       TEXT NOT NULL DEFAULT '',
  blob_path   TEXT NOT NULL DEFAULT '', -- on-disk path of the original blob
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_files_scope
  ON project_memory_files(owner_id, scope_kind, scope_id);

CREATE TABLE IF NOT EXISTS project_memory_texts (
  file_id   TEXT PRIMARY KEY,           -- 1:1 with project_memory_files.id
  text      TEXT NOT NULL,              -- capped at 250,000 chars
  truncated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project_memory_instructions (
  owner_id              TEXT NOT NULL,
  scope_kind            TEXT NOT NULL,
  scope_id              TEXT NOT NULL,
  transcription_summary TEXT NOT NULL DEFAULT '',
  co_creation           TEXT NOT NULL DEFAULT '',
  ai_command            TEXT NOT NULL DEFAULT '',
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (owner_id, scope_kind, scope_id)
);
```

Blob storage: originals go on disk at
`<dataDir>/project-memory/<owner_id>/<file_id>` (raw bytes, no extension);
`blob_path` records the path. Deleting a file removes its text row and blob;
deleting a scope removes all three kinds for that `(owner_id, scope_kind,
scope_id)`.

---

## 2. Route table (H6)

All routes authenticated via the existing `d.Auth.RequireAuth` middleware, and
registered in `server-go/internal/httpapi/router.go`. `{scopeKind}` is
`project` or `space` (reject anything else with 400). Every query filters by
the authenticated `owner_id` — cross-user access returns 404.

| Method | Path | Body / response |
|---|---|---|
| GET | `/project-memory/{scopeKind}/{scopeId}/files` | → `200 [ProjectMemoryFile]` (camelCase JSON, matching the TS type) |
| POST | `/project-memory/{scopeKind}/{scopeId}/files` | multipart/form-data (fields below) → `201 ProjectMemoryFile` |
| DELETE | `/project-memory/files/{id}` | → `204` |
| GET | `/project-memory/files/{id}/text` | → `200 {"text": string, "truncated": bool}` |
| GET | `/project-memory/{scopeKind}/{scopeId}/instructions` | → `200 ProjectInstructions` (all-empty object when never saved) |
| PUT | `/project-memory/{scopeKind}/{scopeId}/instructions` | JSON `ProjectInstructions` → `204` |
| DELETE | `/project-memory/{scopeKind}/{scopeId}` | whole-scope cleanup → `204` (idempotent: 204 even when empty) |

### Upload multipart fields

| Field | Required | Notes |
|---|---|---|
| `file` | yes | the original blob; **reject > 20 MB with 413** and error `"file exceeds 20 MB limit"` |
| `name` | yes | original filename |
| `mimeType` | yes | client-detected mime |
| `title` | yes | client-generated |
| `description` | yes | client-generated |
| `extractedText` | no | present when the browser parsed the format (txt/md/csv/json) |

### Upload behavior (no AI, ever)

1. Enforce the 20 MB limit; persist the blob to `blob_path`.
2. If `extractedText` present → store it (cap 250k chars, set `truncated`),
   `status = "indexed"`.
3. Else if mime is PDF/DOCX/PPTX/XLSX → run H7 extraction **synchronously in
   the request**; success → store text, `status = "indexed"`; failure → keep
   the blob, `status = "failed"`, `error` set.
4. Else → `status = "failed"`, `error = "unsupported file type"`.
5. Respond `201` with the final row — the client never sees a transient
   `queued`/`extracting` from this endpoint.

Decompression-bomb guard (Office/zip in H6/H7): cap total decompressed bytes
read at 50 MB; exceeding it is an extraction failure, not a panic.

---

## 3. Go store methods (H5)

Types and methods added to `server-go/internal/storage/store.go`, on the
existing `AccountStore` interface (implement in `storage/sqlite`, mirror in
`storage/memory` if the shared contract tests require it). Model the SQL on
the existing `documents` methods; every method that touches a row filters by
`ownerID` and returns `storage.ErrNotFound` on a cross-user or missing id.

```go
type ProjectMemoryFile struct {
	ID          string    `json:"id"`
	OwnerID     string    `json:"-"`
	ScopeKind   string    `json:"scopeKind"` // "project" | "space"
	ScopeID     string    `json:"scopeId"`
	Name        string    `json:"name"`
	MimeType    string    `json:"mimeType"`
	Size        int64     `json:"size"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Status      string    `json:"status"` // queued|extracting|indexed|failed
	Error       string    `json:"error,omitempty"`
	BlobPath    string    `json:"-"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type ProjectInstructions struct {
	TranscriptionSummary string `json:"transcriptionSummary"`
	CoCreation           string `json:"coCreation"`
	AICommand            string `json:"aiCommand"`
}

// Added to AccountStore:
CreatePMFile(ctx context.Context, f ProjectMemoryFile) (ProjectMemoryFile, error) // fills ID/timestamps if empty
ListPMFiles(ctx context.Context, ownerID, scopeKind, scopeID string) ([]ProjectMemoryFile, error) // created_at DESC
GetPMFile(ctx context.Context, ownerID, fileID string) (ProjectMemoryFile, error)
UpdatePMFileStatus(ctx context.Context, ownerID, fileID, status, errMsg string) error
DeletePMFile(ctx context.Context, ownerID, fileID string) error // cascades text row; caller removes the blob file

PutPMText(ctx context.Context, ownerID, fileID, text string, truncated bool) error // 404 unless owner matches
GetPMText(ctx context.Context, ownerID, fileID string) (text string, truncated bool, err error)

GetPMInstructions(ctx context.Context, ownerID, scopeKind, scopeID string) (ProjectInstructions, error) // zero-value (not ErrNotFound) when never saved
PutPMInstructions(ctx context.Context, ownerID, scopeKind, scopeID string, ins ProjectInstructions) error // upsert

// Returns the blob paths of the deleted files so the handler can unlink them.
DeletePMScope(ctx context.Context, ownerID, scopeKind, scopeID string) (blobPaths []string, err error)
```

Timestamps serialize as RFC3339Nano strings (existing convention), which
matches the TS `createdAt`/`updatedAt: string`.

---

## 4. Server-side extraction signatures (H7)

`server-go/internal/projectmemory/extract.go`:

```go
// ExtractText turns raw bytes into plain text for pdf/docx/pptx/xlsx.
// Output capped at 250,000 chars (truncated=true when cut). Never panics;
// unsupported or unparseable input returns ("", false, err).
func ExtractText(data []byte, mimeType, filename string) (text string, truncated bool, err error)

// Supported reports whether ExtractText can handle the type in this build.
func Supported(mimeType, filename string) bool
```

---

## 5. Cross-references

- TS interfaces (LocalStore, MemoryClient, modal props, extraction, Stage-A
  shapes, caps): `services/project-memory/types.ts` — **the** contract file.
- Wire types shared with prompt/request contracts:
  `shared-contract/project-memory.ts`.
- Helper task order and acceptance checks: `PROJECT_MEMORY_HELPER_PLAYBOOK.md`.
