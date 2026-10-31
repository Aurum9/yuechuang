package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

const version = "0.1.0"
const nativeHost = "com.yuechuang.helper"

type request struct {
	ID         string `json:"id"`
	Command    string `json:"command"`
	AccountID  string `json:"accountId,omitempty"`
	NewAccount bool   `json:"newAccount,omitempty"`
}
type appError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *appError) Error() string        { return e.Code }
func failure(code, message string) error { return &appError{code, message} }

type response struct {
	ID     string    `json:"id"`
	OK     bool      `json:"ok"`
	Result any       `json:"result,omitempty"`
	Error  *appError `json:"error,omitempty"`
}

func main() {
	// Chrome supplies the extension origin. Never expose the credential commands
	// to an arbitrary caller or accept an origin override from a request payload.
	exe, err := os.Executable()
	if err != nil || len(os.Args) < 2 {
		return
	}
	if err = validateOrigin(filepath.Join(filepath.Dir(exe), "helper-config.json"), os.Args[1]); err != nil {
		return
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return
	}
	s := &diskStore{dir: filepath.Join(base, "YuechuangHelper"), protect: protectData, unprotect: unprotectData, lock: acquireFileLock}
	a := newApp(s)
	runNative(os.Stdin, os.Stdout, a.dispatch)
}

func validateOrigin(path, origin string) error {
	if !regexp.MustCompile(`^chrome-extension://[a-p]{32}/$`).MatchString(origin) {
		return errors.New("invalid extension origin")
	}
	b, err := os.ReadFile(path)
	if err != nil || len(b) > 8192 {
		return errors.New("missing helper config")
	}
	var config struct {
		AllowedOrigins []string `json:"allowedOrigins"`
	}
	if json.Unmarshal(b, &config) != nil {
		return errors.New("invalid helper config")
	}
	for _, allowed := range config.AllowedOrigins {
		if allowed == origin {
			return nil
		}
	}
	return errors.New("extension not allowed")
}

func runNative(r io.Reader, w io.Writer, dispatch func(context.Context, request) (any, error)) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var wg sync.WaitGroup
	var output sync.Mutex
	// One operation at a time plus a cancellation command. A fixed semaphore
	// bounds untrusted request concurrency without blocking cancelLogin.
	slots := make(chan struct{}, 8)
	for {
		data, err := readFrame(r)
		if err != nil {
			break
		}
		var req request
		if json.Unmarshal(data, &req) != nil || req.ID == "" || len(req.ID) > 128 {
			break
		}
		select {
		case slots <- struct{}{}:
		default:
			cancel()
			wg.Wait()
			return
		}
		wg.Add(1)
		go func(req request) {
			defer wg.Done()
			defer func() { <-slots }()
			result, err := dispatch(ctx, req)
			reply := response{ID: req.ID, OK: err == nil, Result: result}
			if err != nil {
				var safe *appError
				if !errors.As(err, &safe) {
					safe = &appError{"internalError", "本地助手操作失败，请重试。"}
				}
				reply.Result = nil
				reply.Error = safe
			}
			output.Lock()
			defer output.Unlock()
			if err := writeFrame(w, reply); err != nil {
				cancel()
			}
		}(req)
	}
	// Browser pipe closure must stop pending login, its listener, and network
	// requests. A live native port is retained by the extension during login.
	cancel()
	wg.Wait()
}
