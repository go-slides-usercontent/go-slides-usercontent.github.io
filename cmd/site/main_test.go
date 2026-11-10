// Copyright (c) the go-slides authors.
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderWritesEveryFileWithTheOriginsIn(t *testing.T) {
	dir := t.TempDir()
	if err := Render([]string{"https://go-slides.github.io", "https://example.github.io"}, "abc-123", dir, false); err != nil {
		t.Fatal(err)
	}
	for _, n := range Files {
		b, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "@@") {
			t.Errorf("%s: a placeholder was left", n)
		}
	}
	js, _ := os.ReadFile(filepath.Join(dir, "shell.js"))
	for _, want := range []string{`const ALLOW = ["https://go-slides.github.io", "https://example.github.io"];`, `GITLAB_CLIENT_ID = "abc-123"`} {
		if !strings.Contains(string(js), want) {
			t.Errorf("shell.js lacks %q", want)
		}
	}
}

func TestRenderRefusesWhatIsNotAnOrigin(t *testing.T) {
	for _, tc := range []struct {
		allow  []string
		client string
		local  bool
	}{
		{nil, "", false},
		{[]string{"http://go-slides.github.io"}, "", false},
		{[]string{"https://go-slides.github.io/x"}, "", false},
		{[]string{"https://Go-Slides.github.io"}, "", false},
		{[]string{"https://go-slides.github.io:8443"}, "", false},
		{[]string{`https://a.io"];alert(1)//`}, "", false},
		{[]string{"http://127.0.0.1:8080"}, "", false}, // loopback only with --local
		{[]string{"https://a.github.io", "https://a.github.io"}, "", false},
		{[]string{"https://a.github.io"}, `x"; alert(1); "`, false},
	} {
		dir := filepath.Join(t.TempDir(), "out")
		if err := Render(tc.allow, tc.client, dir, tc.local); err == nil {
			t.Errorf("Render(%q, %q) accepted", tc.allow, tc.client)
		}
		if _, err := os.Stat(dir); err == nil {
			t.Errorf("Render(%q) wrote files before refusing", tc.allow)
		}
	}
	if err := Render([]string{"http://127.0.0.1:8080"}, "", t.TempDir(), true); err != nil {
		t.Errorf("--local loopback: %v", err)
	}
}

func TestCommand(t *testing.T) {
	var out, errb bytes.Buffer
	c := RootCmd()
	c.SetOut(&out)
	c.SetErr(&errb)
	c.SetArgs([]string{"--allow", "https://go-slides.github.io", "--out", filepath.Join(t.TempDir(), "s"), "--no-wasm"})
	if err := c.Execute(); err != nil || !strings.Contains(out.String(), "written for https://go-slides.github.io") {
		t.Fatalf("%v: %s", err, out.String())
	}
	c = RootCmd()
	c.SetOut(&out)
	c.SetErr(&errb)
	c.SetArgs([]string{"--allow", "https://go-slides.github.io"})
	if err := c.Execute(); err == nil {
		t.Error("no --out accepted")
	}
}
