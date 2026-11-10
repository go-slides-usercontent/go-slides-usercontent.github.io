// Copyright (c) the go-slides authors.
// SPDX-License-Identifier: BSD-3-Clause

// Package frame is what the go-slides playground's git frame does, on the
// second origin go-slides-usercontent.github.io: it holds the forge token and
// runs the forge calls, so the playground page never sees the token
// (go-slides/go-slides.github.io#90).
//
// The playground used to do this in its own page (playground/cmd/playground-wasm/
// git.go, playground/gitvm.go): the token was typed into a canvas field and
// lived in the page's memory, where a script injected into the page could read
// it. Here it is typed into a real password input of this origin's document and
// kept, if the person says so, in this origin's localStorage; the page
// (another site: github.io is on the Public Suffix List) holds neither.
//
// This package is the part with no browser in it: the commands the page may
// send, their validation, and the forge calls through browsergit's remote.Remote.
// cmd/frame is the WebAssembly glue and site/shell.js the postMessage side.
package frame

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-browserhttp/browsergit/forge"
	"github.com/go-browserhttp/browsergit/oauth"
	"github.com/go-browserhttp/browsergit/remote"
	"github.com/go-browserhttp/browsergit/secret"
)

const (
	// GitHubAPI and GitLabBase are the only origins a token is sent to. The
	// shell's CSP names the same two in connect-src.
	GitHubAPI  = "https://api.github.com"
	GitLabBase = "https://gitlab.com"

	// BranchPrefix is where every proposal's branch goes.
	BranchPrefix = "slides/"

	MaxTitleRunes = 120
	MaxBodyBytes  = 4096
	MaxRefBytes   = 200
	MaxTokenBytes = 4096
)

// Forges are the forges a token may be for.
var Forges = []string{"github", "gitlab"}

// Origin is the API origin a token of forge is sent to: what a kept token is
// recorded against.
func Origin(name string) string {
	if name == "gitlab" {
		return GitLabBase
	}
	return GitHubAPI
}

// ErrCommand is a command the frame refuses before it does anything.
var ErrCommand = errors.New("frame: command refused")

// ErrNotConnected is a command that needs a token, with none held.
var ErrNotConnected = errors.New("frame: not connected")

func refuse(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrCommand, fmt.Sprintf(format, a...))
}

// Frame is the frame's state: at most one connection.
type Frame struct {
	// NewRemote makes the remote of a forge that authenticates with tok; nil is
	// browsergit's forge package. A test replaces it.
	NewRemote func(forge string, tok secret.Token) (remote.Remote, error)
	// Now is the clock; nil is time.Now.
	Now func() time.Time
	// OAuth is the GitLab application, when one is registered.
	OAuth *oauth.Config

	mu     sync.Mutex
	forge  string
	tok    secret.Token
	tokens *oauth.Tokens // a GitLab sign-in: refreshed before use
	rem    remote.Remote
}

func (f *Frame) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func defaultRemote(name string, tok secret.Token) (remote.Remote, error) {
	cfg := forge.Config{Kind: forge.GitHub, API: GitHubAPI, Token: tok, BranchPrefix: BranchPrefix}
	if name == "gitlab" {
		cfg.Kind, cfg.API = forge.GitLab, GitLabBase+"/api/v4"
	}
	return forge.New(cfg)
}

func (f *Frame) newRemote(name string, tok secret.Token) (remote.Remote, error) {
	if f.NewRemote != nil {
		return f.NewRemote(name, tok)
	}
	return defaultRemote(name, tok)
}

// Status is what the page may know: whether there is a connection, never what
// it is made of.
type Status struct {
	Connected bool   `json:"connected"`
	Forge     string `json:"forge,omitempty"`
	OAuth     bool   `json:"oauth,omitempty"`
}

func (f *Frame) Status() Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return Status{Connected: f.rem != nil, Forge: f.forge, OAuth: f.tokens != nil}
}

func validForge(name string) bool { return name == "github" || name == "gitlab" }

// Connect takes a personal access token typed into the frame's own field.
func (f *Frame) Connect(name, token string) error {
	if !validForge(name) {
		return refuse("forge %q", name)
	}
	token = strings.TrimSpace(token)
	if token == "" || len(token) > MaxTokenBytes || strings.ContainsAny(token, "\r\n\x00") {
		return refuse("no usable token")
	}
	tok := secret.New(token)
	rem, err := f.newRemote(name, tok)
	if err != nil {
		msg := secret.Redact(err.Error(), tok)
		tok.Forget()
		return errors.New(msg)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.drop()
	f.forge, f.tok, f.rem = name, tok, rem
	return nil
}

// drop forgets the connection; the caller holds the lock.
func (f *Frame) drop() {
	f.tok.Forget()
	f.tokens.Forget()
	f.tok, f.tokens, f.rem, f.forge = secret.Token{}, nil, nil, ""
}

// Disconnect drops the token from memory; a GitLab sign-in is revoked at GitLab.
func (f *Frame) Disconnect(ctx context.Context) {
	f.mu.Lock()
	t, cfg := f.tokens, f.OAuth
	f.tokens = nil // Revoke forgets what it is given; drop must not do it twice
	f.drop()
	f.mu.Unlock()
	if t != nil && cfg != nil {
		_ = cfg.Revoke(ctx, t)
	}
}

// SignInBegin starts GitLab's authorization-code flow with PKCE: the URL to open
// and the attempt, which the shell keeps until the callback comes back.
func (f *Frame) SignInBegin() (oauth.Attempt, string, error) {
	if f.OAuth == nil {
		return oauth.Attempt{}, "", refuse("no GitLab application is registered")
	}
	return f.OAuth.Begin()
}

// SignInFinish trades the callback's code for tokens.
func (f *Frame) SignInFinish(ctx context.Context, a oauth.Attempt, callbackURL string) error {
	if f.OAuth == nil {
		return refuse("no GitLab application is registered")
	}
	t, err := f.OAuth.Finish(ctx, a, callbackURL)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.drop()
	f.tokens, f.forge = t, "gitlab"
	rem, err := f.newRemote("gitlab", t.Access)
	if err != nil {
		f.drop()
		return err
	}
	f.rem = rem
	return nil
}

// use returns the remote for one operation, refreshing a sign-in's tokens first.
func (f *Frame) use(ctx context.Context) (remote.Remote, error) {
	f.mu.Lock()
	t, cfg, rem := f.tokens, f.OAuth, f.rem
	f.mu.Unlock()
	if rem == nil {
		return nil, ErrNotConnected
	}
	if t == nil || cfg == nil || !cfg.Expired(t) {
		return rem, nil
	}
	if err := cfg.Refresh(ctx, t); err != nil {
		f.mu.Lock()
		f.drop()
		f.mu.Unlock()
		return nil, err
	}
	nr, err := f.newRemote("gitlab", t.Access)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.rem = nr
	f.mu.Unlock()
	return nr, nil
}

// redact strips every credential held from an error text before it leaves.
func (f *Frame) redact(err error) error {
	if err == nil {
		return nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	s := secret.Redact(err.Error(), f.tok)
	if f.tokens != nil {
		s = secret.Redact(s, f.tokens.Access, f.tokens.Refresh)
	}
	return errors.New(s)
}

// A LoadArgs is the page's `load` command.
type LoadArgs struct {
	Repo, Ref, Dir string
}

// Check validates what the page asked for before any network call.
func (a LoadArgs) Check(forgeName string) error {
	if err := remote.CheckRepo(a.Repo, forgeName == "gitlab"); err != nil {
		return refuse("%v", err)
	}
	if len(a.Ref) > MaxRefBytes || strings.ContainsAny(a.Ref, "\x00\r\n") {
		return refuse("ref")
	}
	if err := remote.CheckDir(a.Dir); err != nil {
		return refuse("%v", err)
	}
	return nil
}

// Load reads a folder of a repository.
func (f *Frame) Load(ctx context.Context, a LoadArgs) (remote.Files, remote.Base, error) {
	f.mu.Lock()
	name := f.forge
	f.mu.Unlock()
	if name == "" {
		return nil, remote.Base{}, ErrNotConnected
	}
	if err := a.Check(name); err != nil {
		return nil, remote.Base{}, err
	}
	rem, err := f.use(ctx)
	if err != nil {
		return nil, remote.Base{}, f.redact(err)
	}
	files, base, err := rem.Load(ctx, a.Repo, a.Ref, a.Dir)
	return files, base, f.redact(err)
}

// CheckBase validates a base the page sends back: it comes from a page this
// frame does not trust, so it is checked as if it had never been issued.
func CheckBase(b remote.Base, forgeName string) error {
	if b.Forge != forgeName {
		return refuse("base is for forge %q, the connection is %q", b.Forge, forgeName)
	}
	if err := remote.CheckRepo(b.Repo, forgeName == "gitlab"); err != nil {
		return refuse("%v", err)
	}
	if err := remote.CheckDir(b.Dir); err != nil {
		return refuse("%v", err)
	}
	if !remote.IsCommitID(b.Commit) || b.Ref == "" || len(b.Ref) > MaxRefBytes {
		return refuse("base commit or ref")
	}
	for p, id := range b.Blobs {
		if err := remote.CheckPath(p); err != nil {
			return refuse("%v", err)
		}
		if !remote.IsCommitID(id) {
			return refuse("blob id of %q", p)
		}
	}
	return nil
}

// A ProposeArgs is the page's `propose` command.
type ProposeArgs struct {
	Base  remote.Base
	Files remote.Files
	Title string
	Body  string
}

// Propose commits files as a NEW branch under BranchPrefix and opens a pull
// request: the frame, not the page, chooses the branch name.
func (f *Frame) Propose(ctx context.Context, a ProposeArgs) (remote.Result, error) {
	f.mu.Lock()
	name := f.forge
	f.mu.Unlock()
	if name == "" {
		return remote.Result{}, ErrNotConnected
	}
	if err := CheckBase(a.Base, name); err != nil {
		return remote.Result{}, err
	}
	title := strings.TrimSpace(a.Title)
	if title == "" || !utf8.ValidString(title) {
		return remote.Result{}, refuse("title")
	}
	if r := []rune(title); len(r) > MaxTitleRunes {
		title = string(r[:MaxTitleRunes])
	}
	if len(a.Body) > MaxBodyBytes || !utf8.ValidString(a.Body) {
		return remote.Result{}, refuse("body")
	}
	if err := remote.DefaultLimits.CheckFiles(a.Files); err != nil {
		return remote.Result{}, refuse("%v", err)
	}
	rem, err := f.use(ctx)
	if err != nil {
		return remote.Result{}, f.redact(err)
	}
	res, err := rem.Propose(ctx, a.Base, a.Files, remote.Proposal{
		Branch: remote.BranchName(BranchPrefix, title, f.now()),
		Title:  title,
		Body:   a.Body,
	})
	return res, f.redact(err)
}

// Refresh asks whether the base's branch moved; moved files come back, nil
// files when it did not.
func (f *Frame) Refresh(ctx context.Context, b remote.Base) (remote.Files, remote.Base, error) {
	f.mu.Lock()
	name := f.forge
	f.mu.Unlock()
	if name == "" {
		return nil, remote.Base{}, ErrNotConnected
	}
	if err := CheckBase(b, name); err != nil {
		return nil, remote.Base{}, err
	}
	rem, err := f.use(ctx)
	if err != nil {
		return nil, remote.Base{}, f.redact(err)
	}
	files, nb, err := rem.Refresh(ctx, b)
	return files, nb, f.redact(err)
}
