package stt

import "testing"

func TestParseSonioxGroupsFinalsPerSpeaker(t *testing.T) {
	raw := []byte(`{"tokens":[
		{"text":"hello ","is_final":true,"speaker":1,"language":"en"},
		{"text":"world","is_final":true,"speaker":1,"language":"en"},
		{"text":"你好","is_final":true,"speaker":2,"language":"zh"},
		{"text":" partial","is_final":false}
	]}`)
	got, err := parseSonioxMessage(raw)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	// Two speaker runs (final) + one interim.
	if len(got) != 3 {
		t.Fatalf("expected 3 events, got %d: %+v", len(got), got)
	}
	if got[0].Text != "hello world" || !got[0].Final || got[0].Speaker != "S1" || got[0].Language != "en" {
		t.Fatalf("run 1 wrong: %+v", got[0])
	}
	if got[1].Text != "你好" || got[1].Speaker != "S2" || got[1].Language != "zh" {
		t.Fatalf("run 2 wrong: %+v", got[1])
	}
	if got[2].Text != " partial" || got[2].Final {
		t.Fatalf("interim wrong: %+v", got[2])
	}
}

func TestParseSonioxError(t *testing.T) {
	raw := []byte(`{"error_code":401,"error_message":"bad key"}`)
	if _, err := parseSonioxMessage(raw); err == nil {
		t.Fatal("expected error for error_code payload")
	}
}

func TestParseSonioxIgnoresNonJSON(t *testing.T) {
	got, err := parseSonioxMessage([]byte("not json"))
	if err != nil || got != nil {
		t.Fatalf("non-json should be ignored: %v %v", got, err)
	}
}

func TestParseSonioxStringSpeaker(t *testing.T) {
	raw := []byte(`{"tokens":[{"text":"hi","is_final":true,"speaker":"A"}]}`)
	got, _ := parseSonioxMessage(raw)
	if len(got) != 1 || got[0].Speaker != "SA" {
		t.Fatalf("string speaker: %+v", got)
	}
}
