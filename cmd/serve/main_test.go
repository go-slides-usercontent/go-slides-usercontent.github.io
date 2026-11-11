// Copyright (c) the go-slides authors.
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestServesTheDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "shell.html"), []byte("<p>x"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newHandler(dir))
	defer srv.Close()
	r, err := srv.Client().Get(srv.URL + "/shell.html")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 || string(b) != "<p>x" {
		t.Fatalf("%d %q", r.StatusCode, b)
	}
	if r, _ := srv.Client().Get(srv.URL + "/missing"); r.StatusCode != 404 {
		t.Fatalf("missing: %d", r.StatusCode)
	}
}

func TestDirIsRequired(t *testing.T) {
	c := RootCmd()
	c.SetArgs(nil)
	c.SetOut(io.Discard)
	c.SetErr(io.Discard)
	if err := c.Execute(); err == nil {
		t.Fatal("no --dir accepted")
	}
}
