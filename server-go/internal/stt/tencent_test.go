package stt

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestBuildTencentURLSignsSortedQuery(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	got := buildTencentURL("1234567890", "secret-id", "secret-key", "16k_zh_en", now, "voice-1", 42)
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "wss" || parsed.Host != tencentASRHost || parsed.Path != "/asr/v2/1234567890" {
		t.Fatalf("unexpected URL: %s", got)
	}

	query := parsed.Query()
	signature := query.Get("signature")
	query.Del("signature")
	unsigned := tencentASRHost + parsed.Path + "?" + query.Encode()
	mac := hmac.New(sha1.New, []byte("secret-key"))
	_, _ = mac.Write([]byte(unsigned))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if signature != want {
		t.Fatalf("signature mismatch: got %q want %q", signature, want)
	}
	if query.Get("engine_model_type") != "16k_zh_en" ||
		query.Get("voice_format") != "1" ||
		query.Get("voice_id") != "voice-1" {
		t.Fatalf("missing required query params: %v", query)
	}
}

func TestParseTencentMessage(t *testing.T) {
	interim, final, err := parseTencentMessage([]byte(
		`{"code":0,"message":"success","result":{"slice_type":1,"voice_text_str":"正在识别"}}`,
	))
	if err != nil || final || interim == nil || interim.Final || interim.Text != "正在识别" {
		t.Fatalf("bad interim: transcript=%+v final=%v err=%v", interim, final, err)
	}

	stable, final, err := parseTencentMessage([]byte(
		`{"code":0,"message":"success","result":{"slice_type":2,"voice_text_str":"识别完成。"}}`,
	))
	if err != nil || final || stable == nil || !stable.Final || stable.Text != "识别完成。" {
		t.Fatalf("bad stable result: transcript=%+v final=%v err=%v", stable, final, err)
	}

	none, final, err := parseTencentMessage([]byte(`{"code":0,"message":"success","final":1}`))
	if err != nil || !final || none != nil {
		t.Fatalf("bad final frame: transcript=%+v final=%v err=%v", none, final, err)
	}
}

func TestParseTencentError(t *testing.T) {
	_, _, err := parseTencentMessage([]byte(`{"code":4001,"message":"invalid signature"}`))
	if err == nil || !strings.Contains(err.Error(), "4001") {
		t.Fatalf("expected provider error, got %v", err)
	}
}

func TestTencentLiveCredentials(t *testing.T) {
	appID := os.Getenv("TENCENT_CLOUD_APP_ID")
	secretID := os.Getenv("TENCENT_CLOUD_SECRET_ID")
	secretKey := os.Getenv("TENCENT_CLOUD_SECRET_KEY")
	if appID == "" || secretID == "" || secretKey == "" {
		t.Skip("Tencent Cloud credentials are not configured")
	}
	engineModel := os.Getenv("TENCENT_ENGINE_MODEL")
	if engineModel == "" {
		engineModel = "16k_zh"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := NewTencent(appID, secretID, secretKey, engineModel).Open(ctx, Config{
		SampleRate: 16000, NumChannels: 1, Language: "auto",
	})
	if err != nil {
		t.Fatalf("open live Tencent ASR: %v", err)
	}
	defer session.Close()

	// Five 200ms silent PCM frames validate authentication and streaming without
	// sending real speech or exposing credentials in test output.
	frame := make([]byte, 6400)
	for range 5 {
		select {
		case providerErr, ok := <-session.Errors():
			if ok && providerErr != nil {
				t.Fatalf("live Tencent ASR error: %v", providerErr)
			}
		default:
		}
		if err := session.SendAudio(ctx, frame); err != nil {
			select {
			case providerErr, ok := <-session.Errors():
				if ok && providerErr != nil {
					t.Fatalf("live Tencent ASR error: %v", providerErr)
				}
			case <-time.After(500 * time.Millisecond):
			}
			t.Fatalf("send live Tencent ASR audio: %v", err)
		}
		time.Sleep(200 * time.Millisecond)
	}
	select {
	case err, ok := <-session.Errors():
		if ok && err != nil {
			t.Fatalf("live Tencent ASR error: %v", err)
		}
	case <-time.After(1500 * time.Millisecond):
		// No provider error after handshake + streamed audio means the live
		// credentials and signed URL were accepted.
	}
}
