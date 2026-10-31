package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testStore(t *testing.T) *diskStore {
	t.Helper()
	var mu sync.Mutex
	return &diskStore{dir: t.TempDir(), protect: func(b []byte) ([]byte, error) { return append([]byte("protected:"), b...), nil }, unprotect: func(b []byte) ([]byte, error) {
		if !bytes.HasPrefix(b, []byte("protected:")) {
			return nil, errors.New("bad protection")
		}
		return append([]byte(nil), b[len("protected:"):]...), nil
	}, lock: func(context.Context, string) (func(), error) { mu.Lock(); return mu.Unlock, nil }}
}
func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var ae *appError
	if !errors.As(err, &ae) || ae.Code != code {
		t.Fatalf("error %v, want %s", err, code)
	}
}

type oauthFixture struct {
	server         *httptest.Server
	key            *rsa.PrivateKey
	mu             sync.Mutex
	authorization  url.Values
	exchanges      int
	refreshes      int
	revokes        int
	scope          string
	subject        string
	invalidGrant   bool
	failRevocation bool
	lastRefresh    string
	expectedClient string
}

func newFixture(t *testing.T) *oauthFixture {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &oauthFixture{key: key, scope: "openid email offline_access resource.invoke " + planScope, subject: "test-subject", expectedClient: "oaiapp_own_test_client"}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			json.NewEncoder(w).Encode(map[string]any{"issuer": f.server.URL, "jwks_uri": f.server.URL + "/jwks", "revocation_endpoint": f.server.URL + "/revoke"})
		case "/jwks":
			json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "test", "alg": "RS256", "use": "sig", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
		case "/token":
			r.ParseForm()
			if r.Form.Get("client_id") != f.expectedClient || r.Form.Get("resource") != apiResource {
				t.Error("wrong token client/resource")
				http.Error(w, "bad client", 400)
				return
			}
			if f.invalidGrant {
				w.WriteHeader(400)
				io.WriteString(w, `{"error":"invalid_grant","error_description":"do not expose token-secret"}`)
				return
			}
			refresh := r.Form.Get("grant_type") == "refresh_token"
			nonce := ""
			if refresh {
				f.refreshes++
				f.lastRefresh = r.Form.Get("refresh_token")
				if r.Form.Has("scope") {
					t.Error("refresh must omit scope")
				}
			} else {
				f.exchanges++
				nonce = f.authorization.Get("nonce")
				verifier := r.Form.Get("code_verifier")
				sum := sha256.Sum256([]byte(verifier))
				if len(verifier) < 43 || base64.RawURLEncoding.EncodeToString(sum[:]) != f.authorization.Get("code_challenge") {
					t.Error("PKCE mismatch")
				}
				if r.Form.Get("redirect_uri") != f.authorization.Get("redirect_uri") {
					t.Error("callback URI changed")
				}
			}
			claims := map[string]any{"iss": f.server.URL, "sub": f.subject, "aud": f.expectedClient, "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "nonce": nonce, "email": "person@example.test"}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "access-test-only", "refresh_token": "refresh-rotated-test-only", "id_token": f.jwt(t, claims), "token_type": "Bearer", "expires_in": 3600, "scope": f.scope})
		case "/revoke":
			f.revokes++
			r.ParseForm()
			if r.Form.Get("token_type_hint") != "refresh_token" || r.Form.Get("client_id") != f.expectedClient {
				t.Error("invalid revocation")
			}
			if f.failRevocation {
				w.WriteHeader(503)
			} else {
				w.WriteHeader(200)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}
func (f *oauthFixture) jwt(t *testing.T, claims map[string]any) string {
	t.Helper()
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "test"})
	payload, _ := json.Marshal(claims)
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	sum := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
}
func (f *oauthFixture) app(t *testing.T) *app {
	a := newApp(testStore(t))
	a.issuer = f.server.URL
	a.discoveryEndpoint = f.server.URL + "/.well-known/openid-configuration"
	a.authorizeEndpoint = f.server.URL + "/authorize"
	a.tokenEndpoint = f.server.URL + "/token"
	a.testEndpoints = true
	a.open = func(raw string) error {
		u, err := url.Parse(raw)
		if err != nil {
			return err
		}
		f.mu.Lock()
		f.authorization = u.Query()
		auth := f.authorization
		f.mu.Unlock()
		if auth.Get("state") == "" || auth.Get("nonce") == "" || auth.Get("ext_agent_host_id") == "" || auth.Get("code_challenge_method") != "S256" {
			t.Error("missing OAuth protection")
		}
		if !regexp.MustCompile(`^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(auth.Get("ext_agent_host_id")) {
			t.Error("invalid supported host ID format")
		}
		cb, _ := url.Parse(auth.Get("redirect_uri"))
		if cb.Hostname() != "127.0.0.1" || cb.Path != "/auth/callback" {
			t.Error("invalid loopback")
		}
		q := cb.Query()
		q.Set("state", auth.Get("state"))
		q.Set("code", "code-test-only")
		q.Set("client_id", f.expectedClient)
		cb.RawQuery = q.Encode()
		response, err := http.Get(cb.String())
		if err != nil {
			return err
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Errorf("callback HTTP %d", response.StatusCode)
		}
		return nil
	}
	return a
}

func TestLoginOAuthPlanAndStatusNoSecrets(t *testing.T) {
	f := newFixture(t)
	a := f.app(t)
	result, err := a.login(context.Background(), request{})
	if err != nil {
		t.Fatal(err)
	}
	status := result.(map[string]any)
	if status["state"] != "ready" || status["loginPending"] != false {
		t.Fatalf("bad status: %v", status)
	}
	b, _ := json.Marshal(result)
	for _, secret := range []string{"access-test-only", "refresh-rotated-test-only", "idToken", "accessToken"} {
		if bytes.Contains(b, []byte(secret)) {
			t.Fatal("status leaked secret")
		}
	}
	f.mu.Lock()
	if f.authorization.Get("client_id") != "dynamic_agent_client" || f.authorization.Get("agent_name_hint") != "阅窗" {
		t.Error("not own dynamic registration")
	}
	host := f.authorization.Get("ext_agent_host_id")
	f.mu.Unlock()
	_, err = a.login(context.Background(), request{})
	if err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.authorization.Get("client_id") != f.expectedClient || f.authorization.Has("agent_name_hint") || f.authorization.Get("ext_agent_host_id") != host {
		t.Error("registration was not reused")
	}
}
func TestIdentityOnlyCannotGetAccessToken(t *testing.T) {
	f := newFixture(t)
	f.scope = "openid profile email"
	a := f.app(t)
	result, err := a.login(context.Background(), request{})
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["state"] != "planDenied" {
		t.Fatal("identity-only incorrectly ready")
	}
	_, err = a.accessToken(context.Background(), "")
	requireCode(t, err, "planNotAuthorized")
}
func TestReturningAccountMismatchPreservesCredentials(t *testing.T) {
	f := newFixture(t)
	a := f.app(t)
	if _, err := a.login(context.Background(), request{}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.subject = "different-subject"
	f.mu.Unlock()
	_, err := a.login(context.Background(), request{})
	requireCode(t, err, "accountMismatch")
	a.store.transaction(context.Background(), func(s *storedState) (bool, error) {
		if findAccount(s, "").Subject != "test-subject" {
			t.Fatal("overwrote old account")
		}
		return false, nil
	})
}
func TestFailedExchangeRetainsIssuedClient(t *testing.T) {
	f := newFixture(t)
	f.invalidGrant = true
	a := f.app(t)
	_, err := a.login(context.Background(), request{})
	requireCode(t, err, "reauthRequired")
	f.mu.Lock()
	f.invalidGrant = false
	f.mu.Unlock()
	if _, err = a.login(context.Background(), request{}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.authorization.Get("client_id") != f.expectedClient || f.authorization.Has("agent_name_hint") {
		t.Fatal("lost pending own client ID")
	}
}
func TestCallbackStateClientAndDenial(t *testing.T) {
	for _, tc := range []struct {
		name, query, expected string
		status                int
	}{{"badstate", "state=wrong&code=x&client_id=own", "", 400}, {"duplicatestate", "state=state&state=state&code=x", "", 400}, {"denied", "state=state&error=access_denied", "accessDenied", 200}, {"missingclient", "state=state&code=x", "registrationIncomplete", 200}, {"mismatch", "state=state&code=x&client_id=other", "clientMismatch", 200}} {
		t.Run(tc.name, func(t *testing.T) {
			ch := make(chan callbackResult, 1)
			client := ""
			if tc.name == "mismatch" {
				client = "own"
			}
			rec := httptest.NewRecorder()
			callbackHandler("state", client, ch)(rec, httptest.NewRequest("GET", "http://127.0.0.1/auth/callback?"+tc.query, nil))
			if rec.Code != tc.status {
				t.Fatal(rec.Code)
			}
			if tc.expected != "" {
				requireCode(t, (<-ch).Err, tc.expected)
			} else if len(ch) != 0 {
				t.Fatal("accepted bad state")
			}
		})
	}
}
func TestJWTRejectsInvalidClaimsAndSignature(t *testing.T) {
	f := newFixture(t)
	a := f.app(t)
	base := map[string]any{"iss": f.server.URL, "sub": "subject", "aud": f.expectedClient, "exp": time.Now().Add(time.Hour).Unix(), "nonce": "nonce"}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{{"issuer", func(c map[string]any) { c["iss"] = "https://attacker.test" }}, {"audience", func(c map[string]any) { c["aud"] = "wrong" }}, {"expired", func(c map[string]any) { c["exp"] = time.Now().Add(-time.Second).Unix() }}, {"nonce", func(c map[string]any) { c["nonce"] = "wrong" }}, {"subject", func(c map[string]any) { c["sub"] = "" }}, {"multiAudience", func(c map[string]any) { c["aud"] = []string{f.expectedClient, "other"} }}} {
		t.Run(tc.name, func(t *testing.T) {
			claims := map[string]any{}
			for k, v := range base {
				claims[k] = v
			}
			tc.change(claims)
			_, err := a.validateIDToken(context.Background(), f.jwt(t, claims), f.expectedClient, "nonce", true)
			requireCode(t, err, "identityValidationFailed")
		})
	}
	token := f.jwt(t, base)
	parts := strings.Split(token, ".")
	parts[1] = base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"forged"}`))
	_, err := a.validateIDToken(context.Background(), strings.Join(parts, "."), f.expectedClient, "nonce", true)
	requireCode(t, err, "identityValidationFailed")
}
func TestRefreshRotationSerializesAndNoScope(t *testing.T) {
	f := newFixture(t)
	a := f.app(t)
	if _, err := a.login(context.Background(), request{}); err != nil {
		t.Fatal(err)
	}
	a.store.transaction(context.Background(), func(s *storedState) (bool, error) {
		x := findAccount(s, "")
		x.ExpiresAt = 1
		x.RefreshToken = "initial-refresh-test-only"
		return true, nil
	})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := a.accessToken(context.Background(), "")
			if err != nil {
				t.Error(err)
			} else if result.(map[string]any)["accessToken"] != "access-test-only" {
				t.Error("wrong access token")
			}
		}()
	}
	wg.Wait()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refreshes != 1 || f.lastRefresh != "initial-refresh-test-only" {
		t.Fatal("refresh rotation raced")
	}
}
func TestRefreshInvalidGrantRequiresLogin(t *testing.T) {
	f := newFixture(t)
	a := f.app(t)
	if _, err := a.login(context.Background(), request{}); err != nil {
		t.Fatal(err)
	}
	a.store.transaction(context.Background(), func(s *storedState) (bool, error) { findAccount(s, "").ExpiresAt = 1; return true, nil })
	f.mu.Lock()
	f.invalidGrant = true
	f.mu.Unlock()
	_, err := a.accessToken(context.Background(), "")
	requireCode(t, err, "reauthRequired")
	result, _ := a.status(context.Background())
	if result.(map[string]any)["state"] != "reauthRequired" {
		t.Fatal("lost reauth state")
	}
}
func TestLogoutClearsOnlyTokensAndReportsRevocation(t *testing.T) {
	for _, remoteFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed", true: "unconfirmed"}[remoteFails], func(t *testing.T) {
			f := newFixture(t)
			f.failRevocation = remoteFails
			a := f.app(t)
			if _, err := a.login(context.Background(), request{}); err != nil {
				t.Fatal(err)
			}
			result, err := a.logout(context.Background(), "")
			if err != nil {
				t.Fatal(err)
			}
			status := result.(map[string]any)
			if status["remoteRevocationConfirmed"] == remoteFails || status["state"] != "signedOut" {
				t.Fatal(status)
			}
			a.store.transaction(context.Background(), func(s *storedState) (bool, error) {
				entry := findAccount(s, "")
				if entry.ClientID != f.expectedClient || entry.Subject == "" || s.HostID == "" || entry.AccessToken != "" || entry.RefreshToken != "" || entry.IDToken != "" {
					t.Fatal("incorrect logout persistence")
				}
				return false, nil
			})
		})
	}
}
func TestCancelClosesLoopback(t *testing.T) {
	a := newApp(testStore(t))
	opened := make(chan string, 1)
	a.open = func(raw string) error { u, _ := url.Parse(raw); opened <- u.Query().Get("redirect_uri"); return nil }
	done := make(chan error, 1)
	go func() { _, err := a.login(context.Background(), request{}); done <- err }()
	callback := <-opened
	if _, err := a.dispatch(context.Background(), request{Command: "cancelLogin"}); err != nil {
		t.Fatal(err)
	}
	requireCode(t, <-done, "loginCancelled")
	client := http.Client{Timeout: time.Second}
	if response, err := client.Get(callback); err == nil {
		response.Body.Close()
		t.Fatal("listener survived cancellation")
	}
}
func TestFramingBoundsAndPartialIO(t *testing.T) {
	var encoded bytes.Buffer
	if err := writeFrame(&encoded, map[string]string{"text": "中文"}); err != nil {
		t.Fatal(err)
	}
	body, err := readFrame(&encoded)
	if err != nil || !json.Valid(body) {
		t.Fatal("bad roundtrip")
	}
	for _, size := range []uint32{0, maxMessage + 1} {
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], size)
		if _, err := readFrame(bytes.NewReader(header[:])); err == nil {
			t.Fatal("unbounded message")
		}
	}
	if _, err := readFrame(strings.NewReader("abc")); err == nil {
		t.Fatal("accepted truncated header")
	}
}
func TestOriginGateAndProtectedStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "helper-config.json")
	origin := "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
	os.WriteFile(path, []byte(`{"allowedOrigins":["`+origin+`"]}`), 0600)
	if validateOrigin(path, origin) != nil {
		t.Fatal("configured origin rejected")
	}
	for _, candidate := range []string{"https://example.com/", "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/", origin + "extra"} {
		if validateOrigin(path, candidate) == nil {
			t.Fatal("untrusted origin accepted")
		}
	}
	store := testStore(t)
	var stable string
	for i := 0; i < 2; i++ {
		if err := store.transaction(context.Background(), func(s *storedState) (bool, error) {
			if stable == "" {
				stable = s.HostID
			} else if stable != s.HostID {
				t.Fatal("host identity changed")
			}
			return false, nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(filepath.Join(store.dir, "credentials.bin"))
	if !bytes.HasPrefix(data, []byte("protected:")) {
		t.Fatal("bypassed protector")
	}
}

func TestNativePipeClosureCancelsPendingWork(t *testing.T) {
	reader, writer := io.Pipe()
	var output bytes.Buffer
	started := make(chan struct{})
	done := make(chan struct{})
	var count atomic.Int32
	go func() {
		runNative(reader, &output, func(ctx context.Context, r request) (any, error) {
			count.Add(1)
			close(started)
			<-ctx.Done()
			return nil, failure("loginCancelled", "已取消")
		})
		close(done)
	}()
	if err := writeFrame(writer, request{ID: "request-1", Command: "login"}); err != nil {
		t.Fatal(err)
	}
	<-started
	writer.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("native process remained alive")
	}
	if count.Load() != 1 {
		t.Fatal("unexpected requests")
	}
}

func TestCancelledTransactionCannotCommitLateCredentials(t *testing.T) {
	store := testStore(t)
	if err := store.transaction(context.Background(), func(s *storedState) (bool, error) { return false, nil }); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.dir, "credentials.bin")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	err = store.transaction(ctx, func(s *storedState) (bool, error) {
		s.Active = "late-login"
		s.Accounts = append(s.Accounts, account{ID: "late-login", AccessToken: "must-not-save"})
		cancel()
		return true, nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("cancelled transaction changed protected credentials")
	}
}
