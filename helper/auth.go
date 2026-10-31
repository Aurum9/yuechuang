package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const officialIssuer = "https://auth.openai.com"
const apiResource = "https://api.openai.com/v1"
const planScope = "chatgpt.tokens.use.direct"

type app struct {
	store                                                       *diskStore
	client                                                      *http.Client
	issuer, authorizeEndpoint, tokenEndpoint, discoveryEndpoint string
	open                                                        func(string) error
	mu                                                          sync.Mutex
	cancelLogin                                                 context.CancelFunc
	loginTimeout                                                time.Duration
	// Only unit tests replace fixed official endpoints; no config or request
	// payload can redirect credentials to another server.
	testEndpoints bool
}

func newApp(store *diskStore) *app {
	return &app{store: store, client: &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, issuer: officialIssuer, authorizeEndpoint: officialIssuer + "/api/accounts/authorize", tokenEndpoint: officialIssuer + "/api/accounts/oauth/token", discoveryEndpoint: officialIssuer + "/.well-known/openid-configuration", open: openBrowser, loginTimeout: 5 * time.Minute}
}
func (a *app) pending() bool { a.mu.Lock(); defer a.mu.Unlock(); return a.cancelLogin != nil }
func (a *app) dispatch(ctx context.Context, req request) (any, error) {
	switch req.Command {
	case "status":
		return a.status(ctx)
	case "login":
		return a.login(ctx, req)
	case "cancelLogin":
		a.mu.Lock()
		if a.cancelLogin != nil {
			a.cancelLogin()
		}
		a.mu.Unlock()
		return map[string]any{"cancelled": true}, nil
	case "getAccessToken":
		return a.accessToken(ctx, req.AccountID)
	case "logout":
		return a.logout(ctx, req.AccountID)
	default:
		return nil, failure("unknownCommand", "不支持的本地助手操作。")
	}
}
func (a *app) status(ctx context.Context) (any, error) {
	var result any
	err := a.store.transaction(ctx, func(s *storedState) (bool, error) { result = safeStatus(s, a.pending()); return false, nil })
	return result, err
}

type callbackResult struct {
	Code, ClientID string
	Err            error
}

func callbackHandler(expectedState, expectedClient string, out chan<- callbackResult) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.Method != "GET" || r.URL.Path != "/auth/callback" {
			http.NotFound(w, r)
			return
		}
		q, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil || len(q["state"]) != 1 || subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(expectedState)) != 1 {
			http.Error(w, "Invalid authorization state.", http.StatusBadRequest)
			return
		}
		res := callbackResult{}
		if q.Get("error") != "" {
			res.Err = failure("accessDenied", "登录或套餐授权未完成。请在授权页允许阅窗使用套餐用量。")
		} else if len(q["code"]) != 1 || q.Get("code") == "" || len(q["client_id"]) > 1 {
			http.Error(w, "Incomplete callback.", http.StatusBadRequest)
			return
		} else {
			res.Code = q.Get("code")
			res.ClientID = q.Get("client_id")
			if expectedClient != "" {
				if res.ClientID != "" && res.ClientID != expectedClient {
					res.Err = failure("clientMismatch", "授权返回的应用身份不匹配，请重新登录。")
				}
				res.ClientID = expectedClient
			} else if res.ClientID == "" || res.ClientID == "dynamic_agent_client" {
				res.Err = failure("registrationIncomplete", "授权未返回阅窗自己的客户端身份，请重新登录。")
			}
		}
		select {
		case out <- res:
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			io.WriteString(w, "授权结果已交给阅窗。可以关闭此页面并返回侧栏。")
		default:
			http.Error(w, "Authorization already received.", http.StatusConflict)
		}
	}
}

func (a *app) login(parent context.Context, req request) (any, error) {
	a.mu.Lock()
	if a.cancelLogin != nil {
		a.mu.Unlock()
		return nil, failure("loginInProgress", "已有授权正在进行，请完成或取消后重试。")
	}
	ctx, cancel := context.WithTimeout(parent, a.loginTimeout)
	a.cancelLogin = cancel
	a.mu.Unlock()
	defer func() { cancel(); a.mu.Lock(); a.cancelLogin = nil; a.mu.Unlock() }()
	var selected *account
	var hostID string
	var pendingClient string
	err := a.store.transaction(ctx, func(s *storedState) (bool, error) {
		hostID = s.HostID
		if !req.NewAccount {
			pendingClient = s.PendingClientID
		}
		if !req.NewAccount {
			if existing := findAccount(s, req.AccountID); existing != nil {
				copy := *existing
				selected = &copy
			} else if req.AccountID != "" {
				return false, failure("accountNotFound", "未找到选择的账号。")
			}
		}
		return false, nil
	})
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, failure("callbackUnavailable", "无法启动临时登录回调，请重试。")
	}
	defer listener.Close()
	redirect := "http://" + listener.Addr().String() + "/auth/callback"
	state, err := randomString(32)
	if err != nil {
		return nil, err
	}
	nonce, err := randomString(32)
	if err != nil {
		return nil, err
	}
	verifier, err := randomString(48)
	if err != nil {
		return nil, err
	}
	challenge := sha256.Sum256([]byte(verifier))
	expectedClient := ""
	clientID := "dynamic_agent_client"
	if selected != nil {
		expectedClient = selected.ClientID
		clientID = selected.ClientID
	} else if pendingClient != "" {
		expectedClient = pendingClient
		clientID = pendingClient
	}
	result := make(chan callbackResult, 1)
	handler := callbackHandler(state, expectedClient, result)
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, MaxHeaderBytes: 16 * 1024, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != listener.Addr().String() {
			http.Error(w, "Invalid host.", http.StatusBadRequest)
			return
		}
		handler(w, r)
	})}
	go server.Serve(listener)
	defer server.Close()
	u, err := url.Parse(a.authorizeEndpoint)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("client_id", clientID)
	q.Set("ext_agent_host_id", hostID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", redirect)
	q.Set("scope", "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct")
	q.Set("resource", apiResource)
	q.Set("state", state)
	q.Set("nonce", nonce)
	q.Set("code_challenge_method", "S256")
	q.Set("code_challenge", base64.RawURLEncoding.EncodeToString(challenge[:]))
	if clientID == "dynamic_agent_client" {
		q.Set("agent_name_hint", "阅窗")
	} else if selected != nil && selected.Email != "" {
		q.Set("login_hint", selected.Email)
	}
	// Do not add retained id_token_hint to the URL: account selection is an
	// acceptable extra click and avoids credential-bearing browser history.
	u.RawQuery = q.Encode()
	if err = a.open(u.String()); err != nil {
		return nil, err
	}
	var cb callbackResult
	select {
	case cb = <-result:
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, failure("loginTimeout", "登录已超时，请重新开始。")
		}
		return nil, failure("loginCancelled", "已取消登录。")
	}
	if cb.Err != nil {
		return nil, cb.Err
	}
	// Keep newly issued registration IDs even when exchange requires a fresh
	// sign-in. They are not made active until identity validation succeeds.
	if selected == nil {
		if err = a.store.transaction(ctx, func(s *storedState) (bool, error) { s.PendingClientID = cb.ClientID; return true, nil }); err != nil {
			return nil, err
		}
	}
	tokens, err := a.exchange(ctx, url.Values{"grant_type": {"authorization_code"}, "client_id": {cb.ClientID}, "code": {cb.Code}, "code_verifier": {verifier}, "redirect_uri": {redirect}, "resource": {apiResource}})
	if err != nil {
		return nil, err
	}
	identity, err := a.validateIDToken(ctx, tokens.IDToken, cb.ClientID, nonce, true)
	if err != nil {
		return nil, err
	}
	if selected != nil && (identity.Subject != selected.Subject || identity.Issuer != selected.Issuer) {
		return nil, failure("accountMismatch", "授权账号与选择的账号不一致，原账号凭证已保留。请使用添加账号。")
	}
	digest := sha256.Sum256([]byte(cb.ClientID + "\x00" + identity.Subject))
	id := hex.EncodeToString(digest[:16])
	label := identity.Email
	if label == "" {
		label = "ChatGPT 账号"
	}
	label += " · " + id[:6]
	entry := account{ID: id, ClientID: cb.ClientID, Subject: identity.Subject, Issuer: identity.Issuer, Email: identity.Email, Label: label, AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken, IDToken: tokens.IDToken, ExpiresAt: time.Now().Add(time.Duration(tokens.ExpiresIn) * time.Second).UnixMilli(), Scopes: strings.Fields(tokens.Scope)}
	err = a.store.transaction(ctx, func(s *storedState) (bool, error) {
		existing := findAccount(s, id)
		if existing == nil {
			s.Accounts = append(s.Accounts, entry)
		} else {
			*existing = entry
		}
		s.Active = id
		if s.PendingClientID == cb.ClientID {
			s.PendingClientID = ""
		}
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	// Login may succeed as identity-only. The status explicitly reports
	// planDenied and getAccessToken refuses inference until plan scope exists.
	status, err := a.status(ctx)
	if err == nil {
		status.(map[string]any)["loginPending"] = false
	}
	return status, err
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

func (a *app) exchange(ctx context.Context, form url.Values) (tokenResponse, error) {
	var result tokenResponse
	r, err := http.NewRequestWithContext(ctx, "POST", a.tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return result, err
	}
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("Accept", "application/json")
	response, err := a.client.Do(r)
	if err != nil {
		return result, failure("networkError", "无法连接 OpenAI 授权服务，请稍后重试。")
	}
	defer response.Body.Close()
	b, err := io.ReadAll(io.LimitReader(response.Body, maxMessage+1))
	if err != nil || len(b) > maxMessage {
		return result, failure("invalidTokenResponse", "授权服务返回了无效结果。")
	}
	defer wipe(b)
	if response.StatusCode != 200 {
		var oauth struct {
			Error string `json:"error"`
		}
		json.Unmarshal(b, &oauth)
		if oauth.Error == "invalid_grant" {
			return result, failure("reauthRequired", "授权已失效，请重新登录。")
		}
		return result, failure("tokenExchangeFailed", "OpenAI 未完成凭证签发，请重新登录。")
	}
	if json.Unmarshal(b, &result) != nil || result.AccessToken == "" || !strings.EqualFold(result.TokenType, "Bearer") || result.ExpiresIn <= 0 || result.ExpiresIn > 31*24*3600 {
		return tokenResponse{}, failure("invalidTokenResponse", "授权服务返回了无效凭证。")
	}
	return result, nil
}

func (a *app) accessToken(ctx context.Context, id string) (any, error) {
	var result any
	var operationErr error
	err := a.store.transaction(ctx, func(s *storedState) (bool, error) {
		entry := findAccount(s, id)
		if entry == nil || entry.AccessToken == "" || entry.ReauthRequired {
			return false, failure("reauthRequired", "请先使用 ChatGPT 登录。")
		}
		if !hasScope(*entry, planScope) {
			return false, failure("planNotAuthorized", "当前账号仅完成身份登录，请重新授权 ChatGPT 套餐用量。")
		}
		changed := false
		if expiredSoon(*entry) {
			if entry.RefreshToken == "" {
				entry.ReauthRequired = true
				operationErr = failure("reauthRequired", "登录已到期，请重新授权。")
				return true, nil
			}
			tokens, e := a.exchange(ctx, url.Values{"grant_type": {"refresh_token"}, "client_id": {entry.ClientID}, "refresh_token": {entry.RefreshToken}, "resource": {apiResource}})
			if e != nil {
				var appErr *appError
				if errors.As(e, &appErr) && appErr.Code == "reauthRequired" {
					entry.ReauthRequired = true
					operationErr = e
					return true, nil
				}
				return false, e
			}
			if tokens.IDToken != "" {
				identity, e := a.validateIDToken(ctx, tokens.IDToken, entry.ClientID, "", false)
				if e != nil {
					// A refresh may already have rotated the remote session. Do not
					// keep presenting its old access credential as a ready account.
					entry.ReauthRequired = true
					operationErr = e
					return true, nil
				}
				if identity.Subject != entry.Subject || identity.Issuer != entry.Issuer {
					entry.ReauthRequired = true
					operationErr = failure("accountMismatch", "续期返回的账号不匹配，请重新登录。")
					return true, nil
				}
				entry.IDToken = tokens.IDToken
			}
			entry.AccessToken = tokens.AccessToken
			if tokens.RefreshToken != "" {
				entry.RefreshToken = tokens.RefreshToken
			}
			if tokens.Scope != "" {
				entry.Scopes = strings.Fields(tokens.Scope)
			}
			entry.ExpiresAt = time.Now().Add(time.Duration(tokens.ExpiresIn) * time.Second).UnixMilli()
			changed = true
			if !hasScope(*entry, planScope) {
				operationErr = failure("planNotAuthorized", "套餐用量权限已失效，请重新授权。")
				return true, nil
			}
		}
		switched := s.Active != entry.ID
		s.Active = entry.ID
		result = map[string]any{"accessToken": entry.AccessToken, "expiresAt": entry.ExpiresAt, "accountId": entry.ID}
		return changed || switched, nil
	})
	if err != nil {
		return nil, err
	}
	return result, operationErr
}

func (a *app) logout(ctx context.Context, id string) (any, error) {
	confirmed := false
	err := a.store.transaction(ctx, func(s *storedState) (bool, error) {
		entry := findAccount(s, id)
		if entry == nil {
			return false, nil
		}
		if entry.RefreshToken != "" {
			// Keep the entire network attempt below the extension's native
			// command timeout so local cleanup can still commit on failure.
			revokeCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			confirmed = a.revoke(revokeCtx, *entry)
			cancel()
		}
		entry.AccessToken = ""
		entry.RefreshToken = ""
		entry.IDToken = ""
		entry.ExpiresAt = 0
		entry.Scopes = nil
		entry.ReauthRequired = false
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	status, err := a.status(ctx)
	if err != nil {
		return nil, err
	}
	result := status.(map[string]any)
	result["remoteRevocationConfirmed"] = confirmed
	return result, nil
}

type discovery struct {
	Issuer             string `json:"issuer"`
	JWKSURI            string `json:"jwks_uri"`
	RevocationEndpoint string `json:"revocation_endpoint"`
}

func (a *app) getJSON(ctx context.Context, endpoint string, out any) error {
	request, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return err
	}
	response, err := a.client.Do(request)
	if err != nil {
		return failure("networkError", "无法读取 OpenAI 的凭证校验信息。")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return failure("validationUnavailable", "OpenAI 凭证校验服务暂不可用。")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxMessage+1))
	if err != nil || len(body) > maxMessage {
		return failure("validationUnavailable", "凭证校验信息无效。")
	}
	if json.Unmarshal(body, out) != nil {
		return failure("validationUnavailable", "凭证校验信息无效。")
	}
	return nil
}
func (a *app) discover(ctx context.Context) (discovery, error) {
	var d discovery
	err := a.getJSON(ctx, a.discoveryEndpoint, &d)
	if err != nil {
		return d, err
	}
	if d.Issuer != a.issuer || !a.allowedEndpoint(d.JWKSURI) {
		return d, failure("validationFailed", "OpenAI 身份发现信息不匹配。")
	}
	return d, nil
}
func (a *app) allowedEndpoint(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" {
		return false
	}
	if a.testEndpoints {
		issuer, _ := url.Parse(a.issuer)
		return u.Scheme == issuer.Scheme && u.Host == issuer.Host
	}
	return u.Scheme == "https" && u.Host == "auth.openai.com"
}
func (a *app) revoke(ctx context.Context, entry account) bool {
	d, err := a.discover(ctx)
	if err != nil || !a.allowedEndpoint(d.RevocationEndpoint) {
		return false
	}
	form := url.Values{"token": {entry.RefreshToken}, "token_type_hint": {"refresh_token"}, "client_id": {entry.ClientID}}
	for attempt := 0; attempt < 3; attempt++ {
		r, e := http.NewRequestWithContext(ctx, "POST", d.RevocationEndpoint, strings.NewReader(form.Encode()))
		if e != nil {
			return false
		}
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, e := a.client.Do(r)
		retry := e != nil
		if e == nil {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return true
			}
			retry = resp.StatusCode >= 500
		}
		if !retry || attempt == 2 {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(time.Duration(attempt+1) * 200 * time.Millisecond):
		}
	}
	return false
}
