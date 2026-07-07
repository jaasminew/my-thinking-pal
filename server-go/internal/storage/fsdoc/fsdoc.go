// Package fsdoc is the MVP filesystem DocStore (docs module 04): the cheapest
// engine, directly inspectable/backup-able. Layout per doc:
//
//	<root>/<docId>/snapshot.bin        opaque full-state update (optional)
//	<root>/<docId>/snapshot.ver        snapshot version (text int)
//	<root>/<docId>/upd/<seq>.bin       opaque incremental updates (seq zero-padded)
//
// Updates and snapshots are opaque bytes; the server never parses CRDT.
package fsdoc

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type Store struct {
	root string
	mu   sync.Mutex
	seq  map[string]int64 // docId -> last allocated seq (lazily initialized from disk)
}

func New(root string) *Store {
	return &Store{root: root, seq: map[string]int64{}}
}

func (s *Store) docDir(docID string) string { return filepath.Join(s.root, sanitize(docID)) }
func (s *Store) updDir(docID string) string { return filepath.Join(s.docDir(docID), "upd") }

func (s *Store) AppendUpdate(_ context.Context, docID string, update []byte) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.updDir(docID), 0o755); err != nil {
		return 0, err
	}
	next, err := s.nextSeqLocked(docID)
	if err != nil {
		return 0, err
	}
	path := filepath.Join(s.updDir(docID), fmt.Sprintf("%012d.bin", next))
	if err := os.WriteFile(path, update, 0o644); err != nil {
		return 0, err
	}
	s.seq[docID] = next
	return next, nil
}

func (s *Store) LoadUpdates(_ context.Context, docID string) ([][]byte, int64, error) {
	entries, err := os.ReadDir(s.updDir(docID))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, nil
		}
		return nil, 0, err
	}
	type item struct {
		seq  int64
		name string
	}
	items := make([]item, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".bin") {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSuffix(e.Name(), ".bin"), 10, 64)
		if err != nil {
			continue
		}
		items = append(items, item{seq: n, name: e.Name()})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].seq < items[j].seq })
	updates := make([][]byte, 0, len(items))
	var maxSeq int64
	for _, it := range items {
		b, err := os.ReadFile(filepath.Join(s.updDir(docID), it.name))
		if err != nil {
			return nil, 0, err
		}
		updates = append(updates, b)
		maxSeq = it.seq
	}
	return updates, maxSeq, nil
}

func (s *Store) PutSnapshot(_ context.Context, docID string, snap []byte, version int64) error {
	if err := os.MkdirAll(s.docDir(docID), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(s.docDir(docID), "snapshot.bin"), snap, 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.docDir(docID), "snapshot.ver"), []byte(strconv.FormatInt(version, 10)), 0o644)
}

func (s *Store) LatestSnapshot(_ context.Context, docID string) ([]byte, int64, error) {
	snap, err := os.ReadFile(filepath.Join(s.docDir(docID), "snapshot.bin"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, nil
		}
		return nil, 0, err
	}
	verRaw, _ := os.ReadFile(filepath.Join(s.docDir(docID), "snapshot.ver"))
	ver, _ := strconv.ParseInt(strings.TrimSpace(string(verRaw)), 10, 64)
	return snap, ver, nil
}

func (s *Store) TruncateUpdates(_ context.Context, docID string, throughSeq int64) error {
	entries, err := os.ReadDir(s.updDir(docID))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".bin") {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSuffix(e.Name(), ".bin"), 10, 64)
		if err != nil || n > throughSeq {
			continue
		}
		_ = os.Remove(filepath.Join(s.updDir(docID), e.Name()))
	}
	return nil
}

func (s *Store) nextSeqLocked(docID string) (int64, error) {
	if last, ok := s.seq[docID]; ok {
		return last + 1, nil
	}
	// Cold start: scan existing files for the current max.
	_, maxSeq, err := s.LoadUpdates(context.Background(), docID)
	if err != nil {
		return 0, err
	}
	s.seq[docID] = maxSeq
	return maxSeq + 1, nil
}

// sanitize keeps docIds to a safe filename charset (defense against traversal).
// '.' is intentionally excluded so "." / ".." can never escape the root.
func sanitize(docID string) string {
	out := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '_'
		}
	}, docID)
	if out == "" {
		return "_"
	}
	return out
}
