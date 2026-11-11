# go-slides-usercontent.github.io

The second origin of the [go-slides playground](https://go-slides.github.io/playground/).
github.io is on the Public Suffix List, so this is a different site from the
playground: what runs here has storage of its own and cannot be read by the
playground's page, nor read it.

It serves the playground's **git frame**: the document that holds the GitHub or
GitLab token and runs the forge calls. The playground page embeds it in an
iframe and sends it typed commands over `postMessage`; it never holds the token
([go-slides/go-slides.github.io#90](https://github.com/go-slides/go-slides.github.io/issues/90)).

## The protocol

The page first says `{t: "hello", nonce}` (when the iframe has loaded). The frame
believes it by the message's origin (allow-listed), its source (the framing
window) and the nonce of its URL fragment; until then it says **nothing** to
anybody, and it never asks the browser who framed it (`location.ancestorOrigins`
is missing in Firefox and the referrer is not sent). It then announces
`{t: "ready"}` to the origin that said hello. After that the page sends
`{t, id, nonce, ...}`; the frame answers `{t: "result", id, cmd, ok, data | error}`
and announces `{t: "state"}`.

| command | fields | answer |
|---|---|---|
| `status` | none | `{connected, forge, oauth}` |
| `load` | `repo`, `ref`, `dir` | `{base}` and the files, `{path: Uint8Array}` |
| `propose` | `base`, `files`, `title`, `body` | `{branch, commit, url}`: a new `slides/` branch and a pull (merge) request, never forced |
| `refresh` | `base` | `{base, moved}`, and the files when the branch moved |
| `disconnect` | none | `{connected: false}` |

`propose` is a write, so it is **confirmed in the frame**: the frame shows what is
proposed (title, repository, number of files) and waits for a click on its own
Allow button (a script of the page cannot click inside the frame; a synthetic
click is refused), 120 s at most, one at a time.

Limits that remain, inherent to a page that embeds a frame: a script injected
into the page can read the nonce (the iframe's `src`) and send the typed commands
(read the loaded folder; ask for a proposal, which the person must then confirm in
the frame), and it can draw a fake pane over the frame and ask for a token itself.
Neither returns a credential from the frame; the second is a phishing of the
person, only as visible as a pane that looks wrong.

There is no command that takes or returns a token, and none that signs in: the
token is typed into the frame's own password input, and GitLab's redirect
sign-in (a popup of this origin, `callback.html`, PKCE) is started from the
frame's own button; the popup is opened unnamed and `noopener,noreferrer`, so
neither the playground page nor GitLab's page holds a handle to it or a name to
target, and the way back is a same-origin `BroadcastChannel` (not a
`postMessage`, whose origin there would be GitLab's), checked against the state
kept here. "Remember on this device" keeps the token in **this
origin's** `localStorage`, with the forge it is for, only when ticked;
Disconnect removes it (and revokes a GitLab sign-in).

## What it checks

- It runs only when framed by an origin it was rendered for (`--allow`):
  `location.ancestorOrigins`, else the referrer.
- A message is believed only if its origin is allowed, its source is the
  framing window, and it carries the nonce of the frame's URL fragment.
  Replies go to the origin that asked, never `"*"`.
- Every command is checked against a schema (unknown fields, wrong types, sizes)
  in the script, then again in the WebAssembly module (`frame/`), which also
  checks repository names, paths and the base, names the branch itself and
  redacts the token from every error text.
- The shell's CSP (a meta tag; Pages sends no headers) allows scripts from
  itself, WebAssembly, and connections to itself, `api.github.com` and
  `gitlab.com`.

The playground declares this origin in its `.second-origin.json`; its CI runs
[`secondorigin verify`](https://github.com/go-fleettools/fleettools) against the
published site and fails when the CSP or the origins the shell accepts drift, or
the origin disappears.

## Build and test

```
go run ./cmd/site --allow https://go-slides.github.io --out _site   # writes the site, builds frame.wasm
go test ./...                                                       # the frame's checks
CHROME=... NODE_PATH=... node browsertest/frame.cjs                 # the frame in Chrome, two origins
```

`browsertest/frame.cjs` serves the frame and a stand-in page on two loopback
origins and answers the forges by request interception. It asserts that the page
cannot read the frame or the token (DOM, storage, any message), that the token
only goes to the forge's API in `Authorization`, that load, propose and refresh
work for GitHub and GitLab (personal access token and the PKCE sign-in), and that
off-schema, wrongly nonced and foreign-window messages are ignored.

The GitLab sign-in is off until an application is registered: set
`GITLAB_CLIENT_ID` in `.github/workflows/pages.yml` and register the redirect URI
`https://go-slides-usercontent.github.io/callback.html`.
