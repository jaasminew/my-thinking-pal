package stt

import (
	"context"
	"errors"
)

// NewTencent builds the Tencent Cloud ASR upstream. Selected via
// STT_PROVIDER=tencent. The real-time protocol requires a signed WebSocket
// handshake (HMAC-SHA1 over sorted query params using the secret key); that
// signing/streaming layer is not implemented here yet, so Open returns a clear
// error. The interface + config plumbing exist so switching providers is a
// one-line env change once the signing layer lands — the /stt protocol and the
// frontend never change (module 07.2).
func NewTencent(appID, secretID, secretKey string) Upstream {
	return &tencentUpstream{appID: appID, secretID: secretID, secretKey: secretKey}
}

type tencentUpstream struct {
	appID     string
	secretID  string
	secretKey string
}

func (u *tencentUpstream) Name() string { return "tencent" }

func (u *tencentUpstream) Open(_ context.Context, _ Config) (Session, error) {
	if u.secretID == "" || u.secretKey == "" {
		return nil, errors.New("tencent ASR credentials not set (TENCENT_SECRET_ID / TENCENT_SECRET_KEY)")
	}
	return nil, errors.New("tencent ASR upstream not yet implemented (signed WS protocol) — see docs/modules/07")
}
