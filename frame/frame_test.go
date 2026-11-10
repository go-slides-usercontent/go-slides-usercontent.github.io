// Copyright (c) the go-slides authors.
// SPDX-License-Identifier: BSD-3-Clause

package frame

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/go-browserhttp/browsergit/remote"
	"github.com/go-browserhttp/browsergit/secret"
)

// Not shaped like a real token: a realistic secret in a test is one copy-paste
// away from being treated as a real one.
const TOKEN = "FRAME-TOKEN-PLACEHOLDER-0123456789"

var commit = strings.Repeat("c", 40)

type fakeRemote struct {
	tok      secret.Token
	proposed remote.Proposal
	loaded   LoadArgs
	err      error
}

func (r *fakeRemote) Load(_ context.Context, repo, ref, dir string) (remote.Files, remote.Base, error) {
	r.loaded = LoadArgs{repo, ref, dir}
	return remote.Files{"deck.md": []byte("# hi")}, remote.Base{Forge: "github", Repo: repo, Ref: "main", Commit: commit}, r.err
}

func (r *fakeRemote) Propose(_ context.Context, b remote.Base, f remote.Files, p remote.Proposal) (remote.Result, error) {
	r.proposed = p
	return remote.Result{Branch: p.Branch, Commit: commit, URL: "https://github.com/o/r/pull/1"}, r.err
}

func (r *fakeRemote) Refresh(_ context.Context, b remote.Base) (remote.Files, remote.Base, error) {
	return nil, b, r.err
}

func newFrame() (*Frame, *fakeRemote) {
	r := &fakeRemote{}
	f := &Frame{
		NewRemote: func(name string, tok secret.Token) (remote.Remote, error) { r.tok = tok; return r, nil },
		Now:       func() time.Time { return time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC) },
	}
	return f, r
}

func TestCommandsNeedAConnection(t *testing.T) {
	f, _ := newFrame()
	ctx := context.Background()
	if _, _, err := f.Load(ctx, LoadArgs{Repo: "o/r"}); !errors.Is(err, ErrNotConnected) {
		t.Errorf("load: %v", err)
	}
	if _, err := f.Propose(ctx, ProposeArgs{}); !errors.Is(err, ErrNotConnected) {
		t.Errorf("propose: %v", err)
	}
	if _, _, err := f.Refresh(ctx, remote.Base{}); !errors.Is(err, ErrNotConnected) {
		t.Errorf("refresh: %v", err)
	}
}

func TestConnectLoadProposeRefresh(t *testing.T) {
	f, r := newFrame()
	ctx := context.Background()
	if err := f.Connect("github", "  "+TOKEN+"\n"); err != nil {
		t.Fatal(err)
	}
	if r.tok.Reveal() != TOKEN {
		t.Error("the remote was not given the token, trimmed")
	}
	if s := f.Status(); !s.Connected || s.Forge != "github" {
		t.Errorf("status %+v", s)
	}
	files, base, err := f.Load(ctx, LoadArgs{Repo: "o/r", Dir: "talk"})
	if err != nil || string(files["deck.md"]) != "# hi" || r.loaded.Dir != "talk" {
		t.Fatalf("load: %v %v", err, r.loaded)
	}
	res, err := f.Propose(ctx, ProposeArgs{Base: base, Files: files, Title: "  Fix the title  ", Body: "b"})
	if err != nil || res.URL == "" {
		t.Fatalf("propose: %v", err)
	}
	// the frame, not the page, names the branch: under slides/, never the base
	if want := "slides/fix-the-title-20261110-120000"; r.proposed.Branch != want || r.proposed.Title != "Fix the title" {
		t.Errorf("proposal %+v, want branch %s", r.proposed, want)
	}
	if nf, _, err := f.Refresh(ctx, base); err != nil || nf != nil {
		t.Errorf("refresh of an unmoved branch: %v %v", nf, err)
	}
	f.Disconnect(ctx)
	if s := f.Status(); s.Connected {
		t.Errorf("after disconnect: %+v", s)
	}
	if !r.tok.IsZero() {
		t.Error("the token survived Disconnect")
	}
	if _, _, err := f.Load(ctx, LoadArgs{Repo: "o/r"}); !errors.Is(err, ErrNotConnected) {
		t.Errorf("load after disconnect: %v", err)
	}
}

func TestRefusals(t *testing.T) {
	f, _ := newFrame()
	ctx := context.Background()
	for _, tc := range []struct{ forge, token string }{
		{"bitbucket", TOKEN}, {"", TOKEN}, {"github", ""}, {"github", "  "}, {"github", "a\nb"}, {"github", strings.Repeat("x", MaxTokenBytes+1)},
	} {
		if err := f.Connect(tc.forge, tc.token); !errors.Is(err, ErrCommand) {
			t.Errorf("Connect(%q, %.10q): %v", tc.forge, tc.token, err)
		}
	}
	if err := f.Connect("github", TOKEN); err != nil {
		t.Fatal(err)
	}
	for _, a := range []LoadArgs{
		{Repo: "o"}, {Repo: "o/r/x"}, {Repo: "../r"}, {Repo: "o/r", Dir: "../x"}, {Repo: "o/r", Dir: "/abs"},
		{Repo: "o/r", Ref: strings.Repeat("r", MaxRefBytes+1)}, {Repo: "o/r", Ref: "a\nb"},
	} {
		if _, _, err := f.Load(ctx, a); !errors.Is(err, ErrCommand) {
			t.Errorf("Load(%+v): %v", a, err)
		}
	}
	good := remote.Base{Forge: "github", Repo: "o/r", Ref: "main", Commit: commit}
	badBases := map[string]remote.Base{
		"other forge": {Forge: "gitlab", Repo: "o/r", Ref: "main", Commit: commit},
		"bad commit":  {Forge: "github", Repo: "o/r", Ref: "main", Commit: "abc"},
		"bad repo":    {Forge: "github", Repo: "o", Ref: "main", Commit: commit},
		"no ref":      {Forge: "github", Repo: "o/r", Commit: commit},
		"bad dir":     {Forge: "github", Repo: "o/r", Ref: "main", Commit: commit, Dir: ".."},
		"bad blob":    {Forge: "github", Repo: "o/r", Ref: "main", Commit: commit, Blobs: map[string]string{"a": "zz"}},
		"bad path":    {Forge: "github", Repo: "o/r", Ref: "main", Commit: commit, Blobs: map[string]string{"../a": commit}},
	}
	for name, b := range badBases {
		if _, err := f.Propose(ctx, ProposeArgs{Base: b, Title: "t"}); !errors.Is(err, ErrCommand) {
			t.Errorf("Propose with %s: %v", name, err)
		}
		if _, _, err := f.Refresh(ctx, b); !errors.Is(err, ErrCommand) {
			t.Errorf("Refresh with %s: %v", name, err)
		}
	}
	for name, a := range map[string]ProposeArgs{
		"no title":     {Base: good, Title: "  "},
		"long body":    {Base: good, Title: "t", Body: strings.Repeat("b", MaxBodyBytes+1)},
		"bad path":     {Base: good, Title: "t", Files: remote.Files{"../x": nil}},
		"git dir":      {Base: good, Title: "t", Files: remote.Files{".git/config": nil}},
		"invalid utf8": {Base: good, Title: "\xff"},
	} {
		if _, err := f.Propose(ctx, a); !errors.Is(err, ErrCommand) {
			t.Errorf("Propose with %s: %v", name, err)
		}
	}
	// a long title is cut, not refused
	if _, err := f.Propose(ctx, ProposeArgs{Base: good, Title: strings.Repeat("é", 300)}); err != nil {
		t.Errorf("long title: %v", err)
	}
}

// An error text that came back from the network may carry the token.
func TestErrorsAreRedacted(t *testing.T) {
	f, r := newFrame()
	if err := f.Connect("github", TOKEN); err != nil {
		t.Fatal(err)
	}
	r.err = errors.New("401 for Bearer " + TOKEN + " at https://api.github.com")
	_, _, err := f.Load(context.Background(), LoadArgs{Repo: "o/r"})
	if err == nil || strings.Contains(err.Error(), TOKEN) {
		t.Fatalf("the token left in an error: %v", err)
	}
	_, err = f.Propose(context.Background(), ProposeArgs{Base: remote.Base{Forge: "github", Repo: "o/r", Ref: "main", Commit: commit}, Title: "t"})
	if err == nil || strings.Contains(err.Error(), TOKEN) {
		t.Fatalf("the token left in an error: %v", err)
	}
	// and a failing connect
	f2 := &Frame{NewRemote: func(_ string, tok secret.Token) (remote.Remote, error) {
		return nil, errors.New("cannot use " + tok.Reveal())
	}}
	if err := f2.Connect("github", TOKEN); err == nil || strings.Contains(err.Error(), TOKEN) {
		t.Fatalf("the token left in a connect error: %v", err)
	}
}

func TestAnotherConnectReplacesTheToken(t *testing.T) {
	f, r := newFrame()
	_ = f.Connect("github", TOKEN)
	first := r.tok
	if err := f.Connect("gitlab", "SECOND-"+TOKEN); err != nil {
		t.Fatal(err)
	}
	if !first.IsZero() {
		t.Error("the first token was not forgotten")
	}
	if s := f.Status(); s.Forge != "gitlab" {
		t.Errorf("status %+v", s)
	}
}

func TestOrigins(t *testing.T) {
	if Origin("github") != GitHubAPI || Origin("gitlab") != GitLabBase || Origin("") != GitHubAPI {
		t.Error("origins")
	}
}

func TestSignInNeedsAnApplication(t *testing.T) {
	f, _ := newFrame()
	if _, _, err := f.SignInBegin(); !errors.Is(err, ErrCommand) {
		t.Errorf("begin: %v", err)
	}
	if err := f.SignInFinish(context.Background(), emptyAttempt, "https://x"); !errors.Is(err, ErrCommand) {
		t.Errorf("finish: %v", err)
	}
}
