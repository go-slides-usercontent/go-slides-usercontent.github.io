// Copyright (c) the go-slides authors.
// SPDX-License-Identifier: BSD-3-Clause

package frame

import (
	"testing"

	"github.com/go-browserhttp/browsergit/remote"
)

// Whatever the page sends, the checks end with an answer and never panic.
func FuzzChecks(f *testing.F) {
	f.Add("o/r", "main", "talk", "github", "slides/x", "t")
	f.Add("g/s/p", "", "../x", "gitlab", "", "")
	f.Add("", "a\nb", "/abs", "", "\x00", "\xff")
	f.Fuzz(func(t *testing.T, repo, ref, dir, forge, path, title string) {
		_ = LoadArgs{Repo: repo, Ref: ref, Dir: dir}.Check(forge)
		_ = CheckBase(remote.Base{Forge: forge, Repo: repo, Ref: ref, Dir: dir, Commit: commit, Blobs: map[string]string{path: commit}}, forge)
		_ = remote.DefaultLimits.CheckFiles(remote.Files{path: []byte(title)})
	})
}
