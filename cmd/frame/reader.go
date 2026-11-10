// Copyright (c) the go-slides authors.
// SPDX-License-Identifier: BSD-3-Clause

//go:build js && wasm

package main

import (
	"io"
	"strings"
)

func bytesReader(s string) io.Reader { return strings.NewReader(s) }
