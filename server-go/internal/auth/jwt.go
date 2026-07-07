package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Minimal, dependency-free HS256 JWT. access + refresh tokens are distinguished
// by the `typ` claim; refresh tokens are additionally tracked (by hash) in the
// AccountStore so they can be revoked (docs module 03).

type TokenType string

const (
	AccessToken  TokenType = "access"
	RefreshToken TokenType = "refresh"
)

type Claims struct {
	Sub   string    `json:"sub"`
	Email string    `json:"email"`
	Typ   TokenType `json:"typ"`
	Jti   string    `json:"jti"` // unique per token, so two tokens minted the same second differ
	Iat   int64     `json:"iat"`
	Exp   int64     `json:"exp"`
}

var (
	ErrInvalidToken = errors.New("invalid token")
	ErrExpiredToken = errors.New("token expired")
	ErrWrongType    = errors.New("wrong token type")
)

var b64 = base64.RawURLEncoding

// Sign builds a signed HS256 token for the given claims/secret.
func Sign(secret []byte, c Claims) (string, error) {
	header := b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	body := header + "." + b64.EncodeToString(payload)
	return body + "." + b64.EncodeToString(sign(secret, body)), nil
}

// Verify checks signature + expiry + expected type and returns the claims.
func Verify(secret []byte, token string, want TokenType) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, ErrInvalidToken
	}
	body := parts[0] + "." + parts[1]
	sig, err := b64.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, sign(secret, body)) {
		return Claims{}, ErrInvalidToken
	}
	raw, err := b64.DecodeString(parts[1])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	var c Claims
	if err := json.Unmarshal(raw, &c); err != nil {
		return Claims{}, ErrInvalidToken
	}
	if c.Typ != want {
		return Claims{}, ErrWrongType
	}
	if time.Now().Unix() >= c.Exp {
		return Claims{}, ErrExpiredToken
	}
	return c, nil
}

func sign(secret []byte, body string) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(body))
	return m.Sum(nil)
}

// NewClaims is a small constructor stamping a random jti + iat/exp.
func NewClaims(sub, email string, typ TokenType, ttl time.Duration) Claims {
	now := time.Now()
	nonce := make([]byte, 12)
	_, _ = rand.Read(nonce)
	return Claims{Sub: sub, Email: email, Typ: typ, Jti: b64.EncodeToString(nonce), Iat: now.Unix(), Exp: now.Add(ttl).Unix()}
}
