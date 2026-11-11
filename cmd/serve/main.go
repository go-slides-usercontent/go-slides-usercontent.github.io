// Copyright (c) the go-slides authors.
// SPDX-License-Identifier: BSD-3-Clause

// Command serve serves a rendered site on the loopback interface, for CI: it
// picks a free port, writes it to --port-file and serves --dir, with the media
// types Pages serves (application/wasm included).
package main

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"

	"github.com/spf13/cobra"
)

var osExit = os.Exit

func newHandler(dir string) http.Handler { return http.FileServer(http.Dir(dir)) }

// RootCmd builds the command.
func RootCmd() *cobra.Command {
	var dir, portFile string
	c := &cobra.Command{
		Use:           "serve --dir DIR --port-file FILE",
		Short:         "Serve a rendered site on a free loopback port",
		SilenceUsage:  true,
		SilenceErrors: true,
		Args:          cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if dir == "" {
				return errors.New("--dir is required")
			}
			ln, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				return err
			}
			port := ln.Addr().(*net.TCPAddr).Port
			if portFile != "" {
				if err := os.WriteFile(portFile, []byte(strconv.Itoa(port)), 0o644); err != nil {
					return err
				}
			}
			fmt.Fprintf(cmd.OutOrStdout(), "serving %s on http://127.0.0.1:%d/\n", dir, port)
			return http.Serve(ln, newHandler(dir))
		},
	}
	c.Flags().StringVar(&dir, "dir", "", "the directory to serve")
	c.Flags().StringVar(&portFile, "port-file", "", "write the chosen port here")
	return c
}

func main() {
	if err := RootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "serve:", err)
		osExit(1)
	}
}
