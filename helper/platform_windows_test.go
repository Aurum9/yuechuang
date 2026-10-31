//go:build windows

package main

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestWindowsDPAPIRoundTripAndTamper(t *testing.T) {
	plain := []byte("synthetic-unit-test-token-only")
	encrypted, err := protectData(plain)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, plain) {
		t.Fatal("plaintext on disk")
	}
	decrypted, err := unprotectData(encrypted)
	if err != nil || !bytes.Equal(decrypted, plain) {
		t.Fatal("DPAPI roundtrip failed")
	}
	encrypted[len(encrypted)/2] ^= 1
	if _, err = unprotectData(encrypted); err == nil {
		t.Fatal("tamper accepted")
	}
}
func TestWindowsCrossProcessCompatibleLockAndCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock")
	release, err := acquireFileLock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if second, err := acquireFileLock(ctx, path); err == nil {
		second()
		t.Fatal("concurrent lock accepted")
	}
	release()
	next, err := acquireFileLock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	next()
}
