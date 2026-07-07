package stt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/coder/websocket"
)

const sonioxWSURL = "wss://stt-rt.soniox.com/transcribe-websocket"

// NewSoniox builds the Soniox upstream. Key/model come from the backend env
// (module 07.9) — never the client.
func NewSoniox(apiKey, model string) Upstream {
	if model == "" {
		model = "stt-rt-v5"
	}
	return &sonioxUpstream{apiKey: apiKey, model: model}
}

type sonioxUpstream struct {
	apiKey string
	model  string
}

func (u *sonioxUpstream) Name() string { return "soniox" }

func (u *sonioxUpstream) Open(ctx context.Context, cfg Config) (Session, error) {
	if u.apiKey == "" {
		return nil, errors.New("SONIOX_API_KEY not set")
	}
	cfg = cfg.withDefaults()
	ws, _, err := websocket.Dial(ctx, sonioxWSURL, nil)
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(4 << 20)

	configFrame, _ := json.Marshal(map[string]any{
		"api_key":                        u.apiKey,
		"model":                          u.model,
		"audio_format":                   "pcm_s16le",
		"sample_rate":                    cfg.SampleRate,
		"num_channels":                   cfg.NumChannels,
		"enable_language_identification": true,
		"language_hints":                 []string{"en", "zh"},
		"enable_speaker_diarization":     true,
	})
	if err := ws.Write(ctx, websocket.MessageText, configFrame); err != nil {
		ws.CloseNow()
		return nil, err
	}

	sessCtx, cancel := context.WithCancel(context.Background())
	s := &sonioxSession{
		ws:          ws,
		transcripts: make(chan Transcript, 64),
		errs:        make(chan error, 4),
		cancel:      cancel,
	}
	go s.readLoop(sessCtx)
	return s, nil
}

type sonioxSession struct {
	ws          *websocket.Conn
	transcripts chan Transcript
	errs        chan error
	cancel      context.CancelFunc
}

func (s *sonioxSession) SendAudio(ctx context.Context, pcm []byte) error {
	return s.ws.Write(ctx, websocket.MessageBinary, pcm)
}
func (s *sonioxSession) Transcripts() <-chan Transcript { return s.transcripts }
func (s *sonioxSession) Errors() <-chan error           { return s.errs }

func (s *sonioxSession) Close() error {
	s.cancel()
	return s.ws.Close(websocket.StatusNormalClosure, "")
}

func (s *sonioxSession) readLoop(ctx context.Context) {
	defer close(s.transcripts)
	defer close(s.errs)
	for {
		_, data, err := s.ws.Read(ctx)
		if err != nil {
			if ctx.Err() == nil {
				select {
				case s.errs <- err:
				default:
				}
			}
			return
		}
		ts, perr := parseSonioxMessage(data)
		if perr != nil {
			select {
			case s.errs <- perr:
			default:
			}
			return
		}
		for _, t := range ts {
			select {
			case s.transcripts <- t:
			case <-ctx.Done():
				return
			}
		}
	}
}

// --- pure parsing (mirrors the frontend soniox.ts token grouping) ---

type sonioxToken struct {
	Text     string `json:"text"`
	IsFinal  bool   `json:"is_final"`
	Speaker  any    `json:"speaker"`
	Language string `json:"language"`
}

type sonioxMessage struct {
	Tokens       []sonioxToken `json:"tokens"`
	ErrorCode    any           `json:"error_code"`
	ErrorMessage string        `json:"error_message"`
	ErrorType    string        `json:"error_type"`
}

// parseSonioxMessage turns one Soniox WS message into vendor-neutral transcripts:
// newly-final tokens become one event per speaker run (a turn change mid-batch
// is not glued together), and the remaining non-final tokens become one interim
// event. Non-JSON frames are ignored (returns nil, nil).
func parseSonioxMessage(raw []byte) ([]Transcript, error) {
	var m sonioxMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, nil
	}
	if m.ErrorCode != nil {
		detail := m.ErrorMessage
		if detail == "" {
			detail = m.ErrorType
		}
		return nil, fmt.Errorf("soniox %v: %s", m.ErrorCode, detail)
	}

	var out []Transcript
	var run, runSpeaker, runLang string
	flush := func() {
		if strings.TrimSpace(run) != "" {
			out = append(out, Transcript{Text: run, Final: true, Speaker: runSpeaker, Language: runLang})
		}
		run, runSpeaker, runLang = "", "", ""
	}
	for _, t := range m.Tokens {
		if !t.IsFinal {
			continue
		}
		spk := speakerTag(t.Speaker)
		if run != "" && spk != runSpeaker {
			flush()
		}
		if run == "" {
			runLang = t.Language
		}
		runSpeaker = spk
		run += t.Text
	}
	flush()

	var interim, interimLang string
	for _, t := range m.Tokens {
		if t.IsFinal {
			continue
		}
		if interim == "" {
			interimLang = t.Language
		}
		interim += t.Text
	}
	if strings.TrimSpace(interim) != "" {
		out = append(out, Transcript{Text: interim, Final: false, Language: interimLang})
	}
	return out, nil
}

func speakerTag(s any) string {
	switch v := s.(type) {
	case nil:
		return ""
	case string:
		if v == "" {
			return ""
		}
		return "S" + v
	case float64:
		return "S" + strconv.Itoa(int(v))
	case json.Number:
		return "S" + v.String()
	default:
		return ""
	}
}
