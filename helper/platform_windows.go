//go:build windows

package main

import (
	"context"
	"errors"
	"syscall"
	"time"
	"unsafe"
)

var crypt32 = syscall.NewLazyDLL("crypt32.dll")
var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var shell32 = syscall.NewLazyDLL("shell32.dll")

type dataBlob struct {
	Size uint32
	Data *byte
}

func blob(b []byte) dataBlob {
	if len(b) == 0 {
		return dataBlob{}
	}
	return dataBlob{uint32(len(b)), &b[0]}
}
func protectData(b []byte) ([]byte, error)   { return dpapi(b, false) }
func unprotectData(b []byte) ([]byte, error) { return dpapi(b, true) }
func dpapi(b []byte, decrypt bool) ([]byte, error) {
	in := blob(b)
	var out dataBlob
	name := "CryptProtectData"
	if decrypt {
		name = "CryptUnprotectData"
	}
	r, _, _ := crypt32.NewProc(name).Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 1, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, errors.New("DPAPI failed")
	}
	defer kernel32.NewProc("LocalFree").Call(uintptr(unsafe.Pointer(out.Data)))
	result := append([]byte(nil), unsafe.Slice(out.Data, out.Size)...)
	wipe(unsafe.Slice(out.Data, out.Size))
	return result, nil
}
func acquireFileLock(ctx context.Context, path string) (func(), error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	for {
		h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
		if err == nil {
			return func() { syscall.CloseHandle(h) }, nil
		}
		if err != syscall.Errno(32) && err != syscall.Errno(33) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(40 * time.Millisecond):
		}
	}
}
func openBrowser(url string) error {
	verb, _ := syscall.UTF16PtrFromString("open")
	target, err := syscall.UTF16PtrFromString(url)
	if err != nil {
		return err
	}
	r, _, _ := shell32.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(target)), 0, 0, 1)
	if r <= 32 {
		return failure("browserOpenFailed", "无法打开授权页面，请检查默认浏览器设置。")
	}
	return nil
}
