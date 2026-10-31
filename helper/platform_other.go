//go:build !windows

package main

import (
	"context"
	"errors"
)

func protectData([]byte) ([]byte, error)   { return nil, errors.New("Windows required") }
func unprotectData([]byte) ([]byte, error) { return nil, errors.New("Windows required") }
func acquireFileLock(context.Context, string) (func(), error) {
	return nil, errors.New("Windows required")
}
func openBrowser(string) error { return errors.New("Windows required") }
