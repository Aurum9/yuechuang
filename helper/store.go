package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type account struct {
	ID             string   `json:"id"`
	ClientID       string   `json:"clientId"`
	Subject        string   `json:"subject"`
	Issuer         string   `json:"issuer"`
	Email          string   `json:"email,omitempty"`
	Label          string   `json:"label"`
	AccessToken    string   `json:"accessToken,omitempty"`
	RefreshToken   string   `json:"refreshToken,omitempty"`
	IDToken        string   `json:"idToken,omitempty"`
	ExpiresAt      int64    `json:"expiresAt"`
	Scopes         []string `json:"scopes"`
	ReauthRequired bool     `json:"reauthRequired,omitempty"`
}
type storedState struct {
	Version         int       `json:"version"`
	HostID          string    `json:"hostId"`
	Active          string    `json:"active,omitempty"`
	Accounts        []account `json:"accounts"`
	PendingClientID string    `json:"pendingClientId,omitempty"`
}
type diskStore struct {
	dir       string
	protect   func([]byte) ([]byte, error)
	unprotect func([]byte) ([]byte, error)
	lock      func(context.Context, string) (func(), error)
}

func randomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func newHostID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return "urn:uuid:" + h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], nil
}

func (s *diskStore) transaction(ctx context.Context, fn func(*storedState) (bool, error)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	unlock, err := s.lock(ctx, filepath.Join(s.dir, "credentials.lock"))
	if err != nil {
		return err
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	state := storedState{Version: 1, Accounts: []account{}}
	data, err := os.ReadFile(filepath.Join(s.dir, "credentials.bin"))
	if err == nil {
		if len(data) > maxMessage {
			return errors.New("credential file too large")
		}
		plain, e := s.unprotect(data)
		if e != nil {
			return failure("credentialUnavailable", "当前 Windows 用户无法解密阅窗凭证，请重新登录。")
		}
		defer wipe(plain)
		if json.Unmarshal(plain, &state) != nil || state.Version != 1 {
			return failure("credentialUnavailable", "阅窗凭证格式无效，请重新登录。")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	newHost := state.HostID == ""
	if newHost {
		id, e := newHostID()
		if e != nil {
			return e
		}
		state.HostID = id
	}
	changed, err := fn(&state)
	if err != nil {
		return err
	}
	if !changed && !newHost {
		return nil
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	plain, err := json.Marshal(state)
	if err != nil {
		return err
	}
	defer wipe(plain)
	encrypted, err := s.protect(plain)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, "credentials-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(encrypted)
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(s.dir, "credentials.bin"))
}
func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
func findAccount(state *storedState, id string) *account {
	if id == "" {
		id = state.Active
	}
	for i := range state.Accounts {
		if state.Accounts[i].ID == id {
			return &state.Accounts[i]
		}
	}
	return nil
}
func hasScope(a account, scope string) bool {
	for _, s := range a.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}
func activeStatus(a *account) string {
	if a == nil || a.AccessToken == "" {
		return "signedOut"
	}
	if a.ReauthRequired {
		return "reauthRequired"
	}
	if !hasScope(*a, "chatgpt.tokens.use.direct") {
		return "planDenied"
	}
	return "ready"
}

type accountView struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	Email          string `json:"email,omitempty"`
	PlanAuthorized bool   `json:"planAuthorized"`
}

func viewAccount(a account) accountView {
	return accountView{a.ID, a.Label, a.Email, hasScope(a, "chatgpt.tokens.use.direct") && a.AccessToken != "" && !a.ReauthRequired}
}
func safeStatus(state *storedState, pending bool) map[string]any {
	views := make([]accountView, 0, len(state.Accounts))
	for _, a := range state.Accounts {
		views = append(views, viewAccount(a))
	}
	result := map[string]any{"version": version, "state": activeStatus(findAccount(state, "")), "accounts": views, "loginPending": pending}
	if a := findAccount(state, ""); a != nil {
		result["account"] = viewAccount(*a)
	}
	return result
}
func expiredSoon(a account) bool { return a.ExpiresAt <= time.Now().Add(90*time.Second).UnixMilli() }
