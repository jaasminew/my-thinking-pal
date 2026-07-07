package auth

import (
	"testing"
	"time"
)

func TestSignVerifyRoundTrip(t *testing.T) {
	secret := []byte("s3cr3t")
	tok, err := Sign(secret, NewClaims("user-1", "a@b.com", AccessToken, time.Minute))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	c, err := Verify(secret, tok, AccessToken)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if c.Sub != "user-1" || c.Email != "a@b.com" {
		t.Fatalf("claims mismatch: %+v", c)
	}
}

func TestVerifyRejectsWrongSecret(t *testing.T) {
	tok, _ := Sign([]byte("a"), NewClaims("u", "e", AccessToken, time.Minute))
	if _, err := Verify([]byte("b"), tok, AccessToken); err != ErrInvalidToken {
		t.Fatalf("expected ErrInvalidToken, got %v", err)
	}
}

func TestVerifyRejectsWrongType(t *testing.T) {
	tok, _ := Sign([]byte("a"), NewClaims("u", "e", RefreshToken, time.Minute))
	if _, err := Verify([]byte("a"), tok, AccessToken); err != ErrWrongType {
		t.Fatalf("expected ErrWrongType, got %v", err)
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	tok, _ := Sign([]byte("a"), NewClaims("u", "e", AccessToken, -time.Second))
	if _, err := Verify([]byte("a"), tok, AccessToken); err != ErrExpiredToken {
		t.Fatalf("expected ErrExpiredToken, got %v", err)
	}
}
