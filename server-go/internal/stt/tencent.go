package stt

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const tencentASRHost = "asr.cloud.tencent.com"

// NewTencent builds the Tencent Cloud real-time ASR upstream.
func NewTencent(appID, secretID, secretKey, engineModel string) Upstream {
	if engineModel == "" {
		engineModel = "16k_zh"
	}
	return &tencentUpstream{
		appID: appID, secretID: secretID, secretKey: secretKey, engineModel: engineModel,
	}
}

type tencentUpstream struct {
	appID       string
	secretID    string
	secretKey   string
	engineModel string
}

func (u *tencentUpstream) Name() string { return "tencent" }

func (u *tencentUpstream) Open(ctx context.Context, cfg Config) (Session, error) {
	if u.appID == "" || u.secretID == "" || u.secretKey == "" {
		return nil, errors.New("tencent ASR credentials not set (APPID / SecretId / SecretKey)")
	}
	cfg = cfg.withDefaults()
	if cfg.SampleRate != 16000 {
		return nil, fmt.Errorf("tencent ASR requires 16000 Hz PCM, got %d", cfg.SampleRate)
	}

	voiceID, err := randomVoiceID()
	if err != nil {
		return nil, err
	}
	wsURL := buildTencentURL(
		u.appID, u.secretID, u.secretKey, u.engineModel,
		time.Now(), voiceID, time.Now().UnixNano()%1_000_000_000,
	)
	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("connect tencent ASR: %w", err)
	}
	ws.SetReadLimit(4 << 20)

	sessCtx, cancel := context.WithCancel(context.Background())
	session := &tencentSession{
		ws:          ws,
		transcripts: make(chan Transcript, 64),
		errs:        make(chan error, 4),
		done:        make(chan struct{}),
		cancel:      cancel,
	}
	go session.readLoop(sessCtx)
	return session, nil
}

func buildTencentURL(
	appID, secretID, secretKey, engineModel string,
	now time.Time, voiceID string, nonce int64,
) string {
	path := "/asr/v2/" + appID
	params := url.Values{
		"engine_model_type": {engineModel},
		"expired":           {strconv.FormatInt(now.Add(24*time.Hour).Unix(), 10)},
		"filter_punc":       {"0"},
		"needvad":           {"1"},
		"nonce":             {strconv.FormatInt(nonce, 10)},
		"secretid":          {secretID},
		"timestamp":         {strconv.FormatInt(now.Unix(), 10)},
		"voice_format":      {"1"}, // raw PCM16
		"voice_id":          {voiceID},
	}
	unsigned := tencentASRHost + path + "?" + params.Encode()
	mac := hmac.New(sha1.New, []byte(secretKey))
	_, _ = mac.Write([]byte(unsigned))
	params.Set("signature", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	return "wss://" + tencentASRHost + path + "?" + params.Encode()
}

func randomVoiceID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("create tencent voice id: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

type tencentSession struct {
	ws          *websocket.Conn
	transcripts chan Transcript
	errs        chan error
	done        chan struct{}
	cancel      context.CancelFunc
	closeOnce   sync.Once
}

func (s *tencentSession) SendAudio(ctx context.Context, pcm []byte) error {
	return s.ws.Write(ctx, websocket.MessageBinary, pcm)
}

func (s *tencentSession) Transcripts() <-chan Transcript { return s.transcripts }
func (s *tencentSession) Errors() <-chan error           { return s.errs }

func (s *tencentSession) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		endCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := s.ws.Write(endCtx, websocket.MessageText, []byte(`{"type":"end"}`)); err == nil {
			select {
			case <-s.done:
			case <-endCtx.Done():
			}
		}
		s.cancel()
		closeErr = s.ws.Close(websocket.StatusNormalClosure, "")
	})
	return closeErr
}

func (s *tencentSession) readLoop(ctx context.Context) {
	defer close(s.done)
	defer close(s.transcripts)
	defer close(s.errs)
	for {
		_, raw, err := s.ws.Read(ctx)
		if err != nil {
			if ctx.Err() == nil && websocket.CloseStatus(err) != websocket.StatusNormalClosure {
				select {
				case s.errs <- fmt.Errorf("tencent ASR read: %w", err):
				default:
				}
			}
			return
		}
		transcript, final, parseErr := parseTencentMessage(raw)
		if parseErr != nil {
			select {
			case s.errs <- parseErr:
			default:
			}
			return
		}
		if transcript != nil {
			select {
			case s.transcripts <- *transcript:
			case <-ctx.Done():
				return
			}
		}
		if final {
			return
		}
	}
}

type tencentMessage struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Final   int    `json:"final"`
	Result  *struct {
		SliceType    int    `json:"slice_type"`
		VoiceTextStr string `json:"voice_text_str"`
	} `json:"result"`
}

func parseTencentMessage(raw []byte) (*Transcript, bool, error) {
	var message tencentMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		return nil, false, nil
	}
	if message.Code != 0 {
		return nil, false, fmt.Errorf("tencent ASR %d: %s", message.Code, message.Message)
	}
	if message.Final == 1 {
		return nil, true, nil
	}
	if message.Result == nil || message.Result.VoiceTextStr == "" {
		return nil, false, nil
	}
	return &Transcript{
		Text:  message.Result.VoiceTextStr,
		Final: message.Result.SliceType == 2,
	}, false, nil
}
