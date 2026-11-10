// Copyright (c) the go-slides authors.
// SPDX-License-Identifier: BSD-3-Clause

//go:build js && wasm

// Command frame is the WebAssembly module of the git frame: it exposes
// goFrame.call(op, argsJSON, files) to the frame's own script (site/shell.js),
// which is the only caller. The ops are the ones in package frame; every one is
// validated again here, whatever the script checked.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"syscall/js"
	"time"

	"github.com/go-browserhttp/browsergit/oauth"
	"github.com/go-browserhttp/browsergit/remote"
	"github.com/go-slides-usercontent/go-slides-usercontent.github.io/frame"
)

// maxArgs bounds the JSON a call may carry (the files travel apart).
const maxArgs = 64 << 10

// opTimeout bounds one forge operation.
const opTimeout = 5 * time.Minute

func main() {
	f := &frame.Frame{}
	cfg := js.Global().Get("goFrameConfig")
	if cfg.Type() == js.TypeObject {
		id, redirect := cfg.Get("gitlabClientID"), cfg.Get("redirectURI")
		if id.Type() == js.TypeString && redirect.Type() == js.TypeString && id.String() != "" {
			c := oauth.GitLab(frame.GitLabBase, id.String(), redirect.String())
			f.OAuth = &c
		}
	}
	api := js.Global().Get("Object").New()
	api.Set("call", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return promise(func() (any, error) { return dispatch(f, args) })
	}))
	api.Set("oauth", f.OAuth != nil)
	js.Global().Set("goFrame", api)
	select {} // the page of this module is the frame; it lives as long as it does
}

// promise runs fn away from the event loop and settles a Promise with it.
func promise(fn func() (any, error)) any {
	var h js.Func
	h = js.FuncOf(func(_ js.Value, a []js.Value) any {
		resolve, reject := a[0], a[1]
		go func() {
			v, err := fn()
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			} else {
				resolve.Invoke(v)
			}
		}()
		h.Release()
		return nil
	})
	return js.Global().Get("Promise").New(h)
}

// reply is the answer: the JSON of the result, and files when there are some.
func reply(v any, files remote.Files) (any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	out := js.Global().Get("Object").New()
	out.Set("json", string(b))
	if files != nil {
		o := js.Global().Get("Object").New()
		for p, data := range files {
			u := js.Global().Get("Uint8Array").New(len(data))
			js.CopyBytesToJS(u, data)
			o.Set(p, u)
		}
		out.Set("files", o)
	}
	return out, nil
}

// filesIn reads the object the script built: path -> Uint8Array.
func filesIn(v js.Value) (remote.Files, error) {
	out := remote.Files{}
	if v.Type() != js.TypeObject {
		return out, nil
	}
	keys := js.Global().Get("Object").Call("keys", v)
	if keys.Length() > remote.DefaultLimits.MaxFiles {
		return nil, fmt.Errorf("%w: too many files", frame.ErrCommand)
	}
	var total int64
	for i := 0; i < keys.Length(); i++ {
		k := keys.Index(i).String()
		u := v.Get(k)
		n := u.Get("length").Int()
		total += int64(n)
		if int64(n) > remote.DefaultLimits.MaxFileBytes || total > remote.DefaultLimits.MaxTotalBytes {
			return nil, fmt.Errorf("%w: files over the size limit", frame.ErrCommand)
		}
		b := make([]byte, n)
		js.CopyBytesToGo(b, u)
		out[k] = b
	}
	return out, nil
}

func dispatch(f *frame.Frame, args []js.Value) (any, error) {
	if len(args) < 2 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeString {
		return nil, errors.New("frame: call(op, argsJSON, files)")
	}
	op, raw := args[0].String(), args[1].String()
	if len(raw) > maxArgs {
		return nil, fmt.Errorf("%w: arguments over %d bytes", frame.ErrCommand, maxArgs)
	}
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	dec := func(v any) error {
		d := json.NewDecoder(bytesReader(raw))
		d.DisallowUnknownFields()
		return d.Decode(v)
	}
	switch op {
	case "status":
		return reply(f.Status(), nil)
	case "disconnect":
		f.Disconnect(ctx)
		return reply(f.Status(), nil)
	case "connect":
		var a struct{ Forge, Token string }
		if err := dec(&a); err != nil {
			return nil, fmt.Errorf("%w: %v", frame.ErrCommand, err)
		}
		if err := f.Connect(a.Forge, a.Token); err != nil {
			return nil, err
		}
		return reply(f.Status(), nil)
	case "load":
		var a frame.LoadArgs
		if err := dec(&a); err != nil {
			return nil, fmt.Errorf("%w: %v", frame.ErrCommand, err)
		}
		files, base, err := f.Load(ctx, a)
		if err != nil {
			return nil, err
		}
		return reply(base, files)
	case "propose":
		var a struct {
			Base  remote.Base
			Title string
			Body  string
		}
		if err := dec(&a); err != nil {
			return nil, fmt.Errorf("%w: %v", frame.ErrCommand, err)
		}
		var files remote.Files
		if len(args) > 2 {
			var err error
			if files, err = filesIn(args[2]); err != nil {
				return nil, err
			}
		}
		res, err := f.Propose(ctx, frame.ProposeArgs{Base: a.Base, Files: files, Title: a.Title, Body: a.Body})
		if err != nil {
			return nil, err
		}
		return reply(map[string]string{"branch": res.Branch, "commit": res.Commit, "url": res.URL}, nil)
	case "refresh":
		var b remote.Base
		if err := dec(&b); err != nil {
			return nil, fmt.Errorf("%w: %v", frame.ErrCommand, err)
		}
		files, nb, err := f.Refresh(ctx, b)
		if err != nil {
			return nil, err
		}
		return reply(map[string]any{"base": nb, "moved": files != nil}, files)
	case "signin-begin":
		a, url, err := f.SignInBegin()
		if err != nil {
			return nil, err
		}
		return reply(map[string]any{"attempt": a, "url": url}, nil)
	case "signin-finish":
		var a struct {
			Attempt oauth.Attempt
			URL     string
		}
		if err := dec(&a); err != nil {
			return nil, fmt.Errorf("%w: %v", frame.ErrCommand, err)
		}
		if err := f.SignInFinish(ctx, a.Attempt, a.URL); err != nil {
			return nil, err
		}
		return reply(f.Status(), nil)
	}
	return nil, fmt.Errorf("%w: unknown op %q", frame.ErrCommand, op)
}
