// Copyright (c) the go-slides authors.
// SPDX-License-Identifier: BSD-3-Clause

// Command site writes the site of go-slides-usercontent.github.io, the second
// origin of the go-slides playground:
//
//	site --allow https://go-slides.github.io --out _site
//
// It writes the shell with the playground's origin in it (the only page the
// frame talks to), builds the module (frame.wasm) and copies Go's wasm_exec.js
// beside it. What it writes is what `secondorigin verify` reads back.
package main

import (
	"embed"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

//go:embed all:assets
var assets embed.FS

// Files are the text files of the site, as written (frame.wasm and wasm_exec.js
// are built).
var Files = []string{"index.html", "shell.html", "shell.js", "callback.html", "callback.js"}

var hostRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)
var clientRE = regexp.MustCompile(`^[A-Za-z0-9_-]{0,128}$`)

// CheckOrigin accepts https://host (lower case, no path, no port); with local,
// a loopback http origin with a port, for tests. The value is written into
// JavaScript, so nothing else passes.
func CheckOrigin(o string, local bool) error {
	u, err := url.Parse(o)
	if err != nil || u.Opaque != "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.String() != o {
		return fmt.Errorf("not an origin: %q", o)
	}
	h := u.Hostname()
	switch {
	case u.Scheme == "https" && u.Port() == "" && hostRE.MatchString(h):
		return nil
	case local && u.Scheme == "http" && (h == "127.0.0.1" || h == "localhost"):
		if p, err := strconv.Atoi(u.Port()); err == nil && p > 0 && p < 65536 {
			return nil
		}
	}
	return fmt.Errorf("not an origin: %q (https://host, lower case, no path)", o)
}

// Render writes the text files of the site for allow into dir.
func Render(allow []string, clientID, dir string, local bool) error {
	if len(allow) == 0 {
		return errors.New("--allow: at least one parent origin")
	}
	seen := map[string]bool{}
	for _, o := range allow {
		if err := CheckOrigin(o, local); err != nil {
			return err
		}
		if seen[o] {
			return fmt.Errorf("--allow %q twice", o)
		}
		seen[o] = true
	}
	if !clientRE.MatchString(clientID) {
		return fmt.Errorf("--gitlab-client-id %q: not a client id", clientID)
	}
	js := "["
	for i, o := range allow {
		if i > 0 {
			js += ", "
		}
		js += strconv.Quote(o)
	}
	js += "]"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	r := strings.NewReplacer("@@ALLOW@@", js, "@@GITLAB_CLIENT_ID@@", clientID)
	for _, name := range Files {
		b, err := assets.ReadFile("assets/" + name)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(r.Replace(string(b))), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// Build compiles the module into dir/frame.wasm and copies wasm_exec.js.
func Build(module, dir string, stderr io.Writer) error {
	c := exec.Command("go", "build", "-trimpath", "-o", filepath.Join(dir, "frame.wasm"), "./cmd/frame")
	c.Dir = module
	c.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm", "CGO_ENABLED=0")
	c.Stdout, c.Stderr = stderr, stderr
	if err := c.Run(); err != nil {
		return fmt.Errorf("go build: %w", err)
	}
	g := exec.Command("go", "env", "GOROOT")
	out, err := g.Output()
	if err != nil {
		return fmt.Errorf("go env GOROOT: %w", err)
	}
	root := strings.TrimSpace(string(out))
	b, err := os.ReadFile(filepath.Join(root, "lib", "wasm", "wasm_exec.js"))
	if err != nil {
		b, err = os.ReadFile(filepath.Join(root, "misc", "wasm", "wasm_exec.js"))
	}
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "wasm_exec.js"), b, 0o644)
}

var osExit = os.Exit

// RootCmd builds the command.
func RootCmd() *cobra.Command {
	var (
		allow  []string
		client string
		out    string
		module string
		local  bool
		nowasm bool
	)
	c := &cobra.Command{
		Use:           "site --allow ORIGIN --out DIR",
		Short:         "Write the site of the go-slides second origin",
		SilenceUsage:  true,
		SilenceErrors: true,
		Args:          cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if out == "" {
				return errors.New("--out is required")
			}
			if err := Render(allow, client, out, local); err != nil {
				return err
			}
			if !nowasm {
				if err := Build(module, out, cmd.ErrOrStderr()); err != nil {
					return err
				}
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s: written for %s\n", out, strings.Join(allow, ", "))
			return nil
		},
	}
	f := c.Flags()
	f.StringArrayVar(&allow, "allow", nil, "a playground origin the frame may talk to (repeatable, required)")
	f.StringVar(&client, "gitlab-client-id", "", "the GitLab application's client id (not a secret); empty: no GitLab sign-in")
	f.StringVar(&out, "out", "", "the directory to write")
	f.StringVar(&module, "module", ".", "the module holding cmd/frame")
	f.BoolVar(&local, "local", false, "allow loopback http origins (tests)")
	f.BoolVar(&nowasm, "no-wasm", false, "write the text files only")
	return c
}

func main() {
	c := RootCmd()
	if err := c.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "site:", err)
		osExit(1)
	}
}
