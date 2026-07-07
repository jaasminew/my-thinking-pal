package fsdoc

import (
	"context"
	"testing"
)

func TestAppendLoadTruncateSnapshot(t *testing.T) {
	ctx := context.Background()
	s := New(t.TempDir())

	// Empty doc → no updates, no snapshot.
	ups, max, err := s.LoadUpdates(ctx, "doc1")
	if err != nil || len(ups) != 0 || max != 0 {
		t.Fatalf("empty load: %v %d %v", ups, max, err)
	}

	// Append three updates → monotonic seq, ordered load.
	for i, b := range [][]byte{{1}, {2}, {3}} {
		seq, err := s.AppendUpdate(ctx, "doc1", b)
		if err != nil || seq != int64(i+1) {
			t.Fatalf("append %d: seq=%d err=%v", i, seq, err)
		}
	}
	ups, max, _ = s.LoadUpdates(ctx, "doc1")
	if len(ups) != 3 || max != 3 || ups[0][0] != 1 || ups[2][0] != 3 {
		t.Fatalf("load after appends: %v max=%d", ups, max)
	}

	// Snapshot + truncate through seq 3 → updates gone, snapshot present.
	if err := s.PutSnapshot(ctx, "doc1", []byte("SNAP"), 1); err != nil {
		t.Fatalf("put snapshot: %v", err)
	}
	if err := s.TruncateUpdates(ctx, "doc1", max); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	ups, _, _ = s.LoadUpdates(ctx, "doc1")
	if len(ups) != 0 {
		t.Fatalf("updates should be truncated, got %d", len(ups))
	}
	snap, ver, _ := s.LatestSnapshot(ctx, "doc1")
	if string(snap) != "SNAP" || ver != 1 {
		t.Fatalf("snapshot: %q ver=%d", snap, ver)
	}

	// Post-snapshot append continues the seq (survives future truncation base).
	seq, _ := s.AppendUpdate(ctx, "doc1", []byte{9})
	if seq != 4 {
		t.Fatalf("post-snapshot seq should continue at 4, got %d", seq)
	}
}

func TestSeqSurvivesColdStart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s1 := New(dir)
	_, _ = s1.AppendUpdate(ctx, "d", []byte{1})
	_, _ = s1.AppendUpdate(ctx, "d", []byte{2})

	// Fresh store over the same dir must not reuse seq 1/2.
	s2 := New(dir)
	seq, _ := s2.AppendUpdate(ctx, "d", []byte{3})
	if seq != 3 {
		t.Fatalf("cold-start seq should be 3, got %d", seq)
	}
}
