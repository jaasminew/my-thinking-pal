package projectmemory_test

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"mythinkingpal/server/internal/auth"
	"mythinkingpal/server/internal/documents"
	"mythinkingpal/server/internal/httpapi"
	"mythinkingpal/server/internal/projectmemory"
	"mythinkingpal/server/internal/storage/memory"
)

// newPMServer wires the real router (httpapi.New) with an in-memory store and
// the Project Memory handler, so the test exercises route registration + auth
// middleware exactly as production would.
func newPMServer(t *testing.T) *httptest.Server {
	t.Helper()
	store := memory.New()
	authH := auth.NewHandler(store, []byte("access"), []byte("refresh"), 15*time.Minute, 720*time.Hour)
	docsH := documents.NewHandler(store)
	pmH := projectmemory.NewHandler(store, t.TempDir())
	return httptest.NewServer(httpapi.New(httpapi.Deps{
		Auth:          authH,
		Documents:     docsH,
		ProjectMemory: pmH,
		CORSOrigin:    "*",
	}))
}

type pmFile struct {
	ID          string `json:"id"`
	ScopeKind   string `json:"scopeKind"`
	ScopeID     string `json:"scopeId"`
	Name        string `json:"name"`
	MimeType    string `json:"mimeType"`
	Size        int64  `json:"size"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Status      string `json:"status"`
	Error       string `json:"error,omitempty"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

func registerPM(t *testing.T, srv *httptest.Server, email string) string {
	t.Helper()
	body := map[string]string{"email": email, "password": "password123"}
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", srv.URL+"/auth/register", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register status %d: %s", resp.StatusCode, data)
	}
	var tp struct {
		AccessToken string `json:"accessToken"`
	}
	_ = json.Unmarshal(data, &tp)
	if tp.AccessToken == "" {
		t.Fatalf("no access token in register response: %s", data)
	}
	return tp.AccessToken
}

func doReq(t *testing.T, srv *httptest.Server, method, path, token string, body any) (*http.Response, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, srv.URL+path, r)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

// uploadMultipart builds a multipart/form-data body and POSTs it to the upload
// route. fileField/filename may be empty to omit the file part.
func uploadMultipart(t *testing.T, srv *httptest.Server, token, scopeKind, scopeID string,
	fields map[string]string, fileField, filename string, content []byte,
) (*http.Response, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("write field %s: %v", k, err)
		}
	}
	if fileField != "" {
		fw, err := mw.CreateFormFile(fileField, filename)
		if err != nil {
			t.Fatalf("create form file: %v", err)
		}
		if _, err := fw.Write(content); err != nil {
			t.Fatalf("write file: %v", err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/project-memory/"+scopeKind+"/"+scopeID+"/files", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

// TestProjectMemoryUploadListDelete covers the core H6 acceptance: upload
// creates metadata, list returns it, get text round-trips, delete removes it.
func TestProjectMemoryUploadListDelete(t *testing.T) {
	srv := newPMServer(t)
	defer srv.Close()
	token := registerPM(t, srv, "pm@example.com")
	const scope, scopeID = "project", "board-1"

	// Upload a text file; browser-supplied extractedText → status "indexed".
	text := "This is the extracted text for the project memory file."
	resp, data := uploadMultipart(t, srv, token, scope, scopeID,
		map[string]string{
			"name":          "notes.txt",
			"mimeType":      "text/plain",
			"title":         "Project Notes",
			"description":   "Initial brainstorming notes",
			"extractedText": text,
		},
		"file", "notes.txt", []byte(text))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("upload status %d: %s", resp.StatusCode, data)
	}
	var f pmFile
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if f.Name != "notes.txt" || f.Title != "Project Notes" || f.Description != "Initial brainstorming notes" {
		t.Fatalf("unexpected metadata: %+v", f)
	}
	if f.Status != "indexed" {
		t.Fatalf("status should be indexed, got %q", f.Status)
	}
	if f.Size != int64(len(text)) {
		t.Fatalf("size mismatch: got %d want %d", f.Size, len(text))
	}
	if f.ScopeKind != scope || f.ScopeID != scopeID {
		t.Fatalf("scope mismatch: %+v", f)
	}

	// List → returns the uploaded file.
	resp, data = doReq(t, srv, "GET", "/project-memory/"+scope+"/"+scopeID+"/files", token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list status %d: %s", resp.StatusCode, data)
	}
	var list []pmFile
	if err := json.Unmarshal(data, &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 || list[0].ID != f.ID {
		t.Fatalf("list should contain the uploaded file, got %s", data)
	}

	// Get text → returns the stored extracted text.
	resp, data = doReq(t, srv, "GET", "/project-memory/files/"+f.ID+"/text", token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get text status %d: %s", resp.StatusCode, data)
	}
	var txt struct {
		Text      string `json:"text"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.Unmarshal(data, &txt); err != nil {
		t.Fatalf("decode text: %v", err)
	}
	if txt.Text != text {
		t.Fatalf("text mismatch: got %q want %q", txt.Text, text)
	}

	// Delete → 204, then list is empty and get text 404s.
	resp, data = doReq(t, srv, "DELETE", "/project-memory/files/"+f.ID, token, nil)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status %d: %s", resp.StatusCode, data)
	}
	resp, data = doReq(t, srv, "GET", "/project-memory/"+scope+"/"+scopeID+"/files", token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list after delete status %d: %s", resp.StatusCode, data)
	}
	if err := json.Unmarshal(data, &list); err != nil {
		t.Fatalf("decode list after delete: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("list should be empty after delete, got %s", data)
	}
	resp, data = doReq(t, srv, "GET", "/project-memory/files/"+f.ID+"/text", token, nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("get text after delete should be 404, got %d: %s", resp.StatusCode, data)
	}
}

// TestProjectMemoryOversizedUpload verifies the 20 MB limit (contract §2).
func TestProjectMemoryOversizedUpload(t *testing.T) {
	srv := newPMServer(t)
	defer srv.Close()
	token := registerPM(t, srv, "big@example.com")

	oversized := bytes.Repeat([]byte("x"), 20<<20+1) // 20 MB + 1 byte
	resp, data := uploadMultipart(t, srv, token, "project", "b1",
		map[string]string{
			"name":        "big.bin",
			"mimeType":    "application/octet-stream",
			"title":       "Big",
			"description": "Too big",
		},
		"file", "big.bin", oversized)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized upload should be 413, got %d: %s", resp.StatusCode, data)
	}
	var body struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(data, &body)
	if body.Error != "file exceeds 20 MB limit" {
		t.Fatalf("error message mismatch: got %q want %q", body.Error, "file exceeds 20 MB limit")
	}
}

// TestProjectMemoryUnauthenticated verifies the auth gate refuses unauthenticated requests.
func TestProjectMemoryUnauthenticated(t *testing.T) {
	srv := newPMServer(t)
	defer srv.Close()

	// List without token → 401.
	resp, _ := doReq(t, srv, "GET", "/project-memory/project/b1/files", "", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated list should be 401, got %d", resp.StatusCode)
	}

	// Upload without token → 401.
	resp, _ = uploadMultipart(t, srv, "", "project", "b1",
		map[string]string{
			"name":          "x.txt",
			"mimeType":      "text/plain",
			"title":         "X",
			"description":   "X",
			"extractedText": "hi",
		},
		"file", "x.txt", []byte("hi"))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated upload should be 401, got %d", resp.StatusCode)
	}
}

// TestProjectMemoryInstructions round-trips the per-scope instructions (GET/PUT),
// including the all-empty default when never saved.
func TestProjectMemoryInstructions(t *testing.T) {
	srv := newPMServer(t)
	defer srv.Close()
	token := registerPM(t, srv, "ins@example.com")
	path := "/project-memory/project/ins-1/instructions"

	// Never saved → all-empty object, 200.
	resp, data := doReq(t, srv, "GET", path, token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get instructions status %d: %s", resp.StatusCode, data)
	}
	var ins struct {
		TranscriptionSummary string `json:"transcriptionSummary"`
		CoCreation           string `json:"coCreation"`
		AICommand            string `json:"aiCommand"`
	}
	if err := json.Unmarshal(data, &ins); err != nil {
		t.Fatalf("decode instructions: %v", err)
	}
	if ins.TranscriptionSummary != "" || ins.CoCreation != "" || ins.AICommand != "" {
		t.Fatalf("unsaved instructions should be empty, got %+v", ins)
	}

	// PUT → 204.
	want := map[string]string{
		"transcriptionSummary": "Keep transcripts concise.",
		"coCreation":           "Prefer adjacent suggestions.",
		"aiCommand":            "Summarize action items.",
	}
	resp, data = doReq(t, srv, "PUT", path, token, want)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("put instructions status %d: %s", resp.StatusCode, data)
	}

	// GET → returns the saved values.
	resp, data = doReq(t, srv, "GET", path, token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get instructions after save status %d: %s", resp.StatusCode, data)
	}
	if err := json.Unmarshal(data, &ins); err != nil {
		t.Fatalf("decode instructions after save: %v", err)
	}
	if ins.TranscriptionSummary != want["transcriptionSummary"] ||
		ins.CoCreation != want["coCreation"] ||
		ins.AICommand != want["aiCommand"] {
		t.Fatalf("instructions round-trip mismatch: got %+v want %+v", ins, want)
	}
}
