// The git frame in headless Chrome, on two origins, as an attacker would look at
// it. The frame (this repository's site, rendered for the test) is served on one
// loopback origin and a stand-in for the playground page on another. The forges'
// APIs are answered by request interception, so no real token and no network are
// involved.
//
// It asserts: the frame runs only inside the origin it was rendered for; the
// token is typed in the frame and the page can never read it (not from the frame's
// DOM or storage, not in any message it receives, not in its own storage), and it
// goes to api.github.com / gitlab.com only, in Authorization; the typed commands
// load, propose, refresh and disconnect work for GitHub and for GitLab (a personal
// access token and the redirect sign-in with PKCE); anything off-schema, wrongly
// nonced or sent by another window is ignored; "Remember on this device" is the
// one way into the frame's localStorage and Disconnect takes it out.
//
//   CHROME=/path/to/chrome NODE_PATH=.../node_modules node browsertest/frame.cjs
//
// Prints FRAME_OK {...}.
"use strict";
const puppeteer = require("puppeteer-core");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

// Not shaped like real tokens: a realistic secret in a test is one copy-paste
// away from being treated as a real one.
const TOKEN = "FRAME-TOKEN-PLACEHOLDER-0123456789";
const GL_TOKEN = "FRAME-GITLAB-PLACEHOLDER-9876543210";
const ACCESS = "OAUTH-ACCESS-PLACEHOLDER-1111111111";
const REFRESH = "OAUTH-REFRESH-PLACEHOLDER-2222222222";
const CODE = "OAUTH-CODE-PLACEHOLDER-3333333333";
const NONCE = "n".repeat(8) + crypto.randomBytes(12).toString("hex");
const SECRETS = [TOKEN, GL_TOKEN, ACCESS, REFRESH, CODE, Buffer.from(TOKEN).toString("base64")];
const leaks = (s) => SECRETS.some((t) => s.includes(t));

function fail(msg) {
  console.error("FAIL " + msg);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    if (Date.now() > end) fail("timed out waiting for " + what);
    await sleep(25);
  }
}

// ---- the fake forges --------------------------------------------------------
const deck = "---\ntheme: default\n---\n\n# From a fake forge\n";
const sha1 = (s) => crypto.createHash("sha1").update("blob " + Buffer.byteLength(s) + "\0" + s).digest("hex");
const blobSha = sha1(deck);
let headCommit = "c".repeat(40);
const tree = "d".repeat(40);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Accept, X-GitHub-Api-Version, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH",
};
const calls = []; // every request that reached a forge: {host, method, path, auth, body}

function github(u, method, body) {
  const p = u.pathname;
  if (method === "GET") {
    if (p === "/repos/o/r") return { default_branch: "main" };
    if (p === "/repos/o/r/git/ref/heads/main") return { object: { type: "commit", sha: headCommit } };
    if (p === "/repos/o/r/git/commits/" + headCommit) return { sha: headCommit, tree: { sha: tree } };
    if (p === "/repos/o/r/git/trees/" + tree) {
      return { sha: tree, truncated: false, tree: [
        { path: "talk", mode: "040000", type: "tree", sha: "e".repeat(40) },
        { path: "talk/deck.md", mode: "100644", type: "blob", sha: blobSha, size: Buffer.byteLength(deck) },
      ] };
    }
    if (p === "/repos/o/r/git/blobs/" + blobSha) return { sha: blobSha, encoding: "base64", content: Buffer.from(deck).toString("base64") };
    return null;
  }
  const j = body ? JSON.parse(body) : {};
  if (p === "/repos/o/r/git/blobs") return { sha: sha1(Buffer.from(j.content, "base64").toString()) };
  if (p === "/repos/o/r/git/trees") return { sha: "f".repeat(40) };
  if (p === "/repos/o/r/git/commits") return { sha: "1".repeat(40), tree: { sha: "f".repeat(40) } };
  if (p === "/repos/o/r/git/refs") return {};
  if (p === "/repos/o/r/pulls") return { html_url: "https://github.com/o/r/pull/7" };
  return null;
}

function gitlab(u, method, body) {
  const p = u.pathname.replace(/^\/api\/v4/, "");
  if (method === "GET") {
    if (p === "/projects/g%2Fp") return { default_branch: "main" };
    if (p === "/projects/g%2Fp/repository/branches/main") return { commit: { id: headCommit } };
    if (p === "/projects/g%2Fp/repository/tree") return [{ id: blobSha, type: "blob", path: "talk/deck.md", mode: "100644" }];
    if (p === "/projects/g%2Fp/repository/blobs/" + blobSha + "/raw") return deck;
    return null;
  }
  if (p === "/projects/g%2Fp/repository/commits") return { id: "2".repeat(40) };
  if (p === "/projects/g%2Fp/merge_requests") return { web_url: "https://gitlab.com/g/p/-/merge_requests/3" };
  return null;
}

let challenge = "", redirectURI = "", oauthState = "";
const tokenRequests = [], revokes = [];

function forge(req) {
  const u = new URL(req.url());
  const method = req.method();
  const body = req.postData() || "";
  const auth = req.headers()["authorization"] || "";
  if (method === "OPTIONS") return req.respond({ status: 204, headers: cors });
  calls.push({ host: u.hostname, method, path: u.pathname, auth, body, url: req.url() });
  const json = (o, status = 200, extra = {}) =>
    req.respond({ status, headers: { ...cors, ...extra }, contentType: typeof o === "string" ? "text/plain" : "application/json", body: typeof o === "string" ? o : JSON.stringify(o) });
  if (u.hostname === "gitlab.com" && u.pathname === "/oauth/authorize") {
    // PKCE: the authorize URL carries the challenge only, and the state
    challenge = u.searchParams.get("code_challenge");
    redirectURI = u.searchParams.get("redirect_uri");
    oauthState = u.searchParams.get("state");
    if (u.searchParams.get("code_challenge_method") !== "S256" || u.searchParams.get("client_id") !== "test-client-id") return json("bad authorize", 400);
    return req.respond({ status: 302, headers: { location: redirectURI + "?code=" + CODE + "&state=" + oauthState } });
  }
  if (u.hostname === "gitlab.com" && u.pathname === "/oauth/token") {
    const f = new URLSearchParams(body);
    tokenRequests.push(Object.fromEntries(f));
    const ok = f.get("grant_type") === "authorization_code" && f.get("code") === CODE &&
      crypto.createHash("sha256").update(f.get("code_verifier") || "").digest("base64url") === challenge;
    if (!ok) return json({ error: "invalid_grant" }, 400);
    return json({ access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer", expires_in: 7200, created_at: Math.floor(Date.now() / 1000) });
  }
  if (u.hostname === "gitlab.com" && u.pathname === "/oauth/revoke") {
    revokes.push(body);
    return json({});
  }
  const out = u.hostname === "api.github.com" ? github(u, method, body) : gitlab(u, method, body);
  if (out === null) return json({ message: "Not Found" }, 404);
  return json(out);
}

// ---- the two origins --------------------------------------------------------
function serve(handler) {
  return new Promise((ok) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => ok(s));
  });
}
const mime = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };

// the page: a stand-in for the playground, with a harness to send commands
const pageHTML = `<!doctype html><meta charset="utf-8"><title>page</title><body>
<iframe id="f"></iframe><iframe id="sib" srcdoc="<script>window.attack=function(m){parent.frames[0].postMessage(m,'*')}</script>"></iframe>
<script>
  const NONCE = ${JSON.stringify(NONCE)};
  window.log = [];       // every message received, as text
  window.events = [];    // the frame's state events
  const pending = new Map();
  addEventListener("message", (e) => {
    try { window.log.push(JSON.stringify(e.data, (k, v) => v instanceof Uint8Array ? "bytes:" + new TextDecoder().decode(v) : v)); } catch (_) {}
    const m = e.data;
    if (!m || e.origin !== window.FRAME_ORIGIN) return;
    if (m.t === "result" && pending.has(m.id)) {
      if (m.files) { m.text = {}; for (const p of Object.keys(m.files)) m.text[p] = new TextDecoder().decode(m.files[p]); delete m.files; }
      pending.get(m.id)(m); pending.delete(m.id);
    }
    else if (m.t === "state" || m.t === "ready") window.events.push(m);
  });
  let seq = 0;
  window.send = (t, fields, nonce) => new Promise((ok, ko) => {
    const id = "c" + (++seq);
    pending.set(id, ok);
    document.getElementById("f").contentWindow.postMessage(Object.assign({ t, id, nonce: nonce === undefined ? NONCE : nonce }, fields || {}), window.FRAME_ORIGIN);
    setTimeout(() => { if (pending.delete(id)) ok(null); }, 1500);
  });
  // via about:blank: the frame removes the fragment from its address, so the same
  // URL again would be only a fragment navigation, not a reload
  window.open_ = (src) => {
    const f = document.getElementById("f");
    window.events.length = 0;
    f.src = "about:blank";
    setTimeout(() => { f.src = src; }, 50);
  };
</script>`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-site-"));
  let parent, framesite, other;
  parent = await serve((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(pageHTML); });
  other = await serve((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(pageHTML); });
  const A = "http://127.0.0.1:" + parent.address().port;
  const C = "http://127.0.0.1:" + other.address().port;
  const root = path.resolve(__dirname, "..");
  execFileSync("go", ["run", "./cmd/site", "--local", "--allow", A, "--gitlab-client-id", "test-client-id", "--out", dir], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  framesite = await serve((q, r) => {
    const p = q.url.split("?")[0];
    const f = path.join(dir, p === "/" ? "index.html" : path.basename(p));
    fs.readFile(f, (err, b) => {
      if (err) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { "content-type": mime[path.extname(f)] || "application/octet-stream" });
      r.end(b);
    });
  });
  const B = "http://127.0.0.1:" + framesite.address().port;

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox"] });
  const out = {};
  const hooked = new Map();
  const intercept = (pg) => {
    if (hooked.has(pg)) return hooked.get(pg);
    // registered before the first await: the target event and the caller race
    const p = (async () => {
      await pg.setRequestInterception(true);
      pg.on("request", (req) => {
        const h = new URL(req.url()).hostname;
        if (h === "api.github.com" || h === "gitlab.com") return forge(req);
        if (h !== "127.0.0.1") return req.abort(); // nothing else is reachable
        req.continue();
      });
    })();
    hooked.set(pg, p);
    return p;
  };
  browser.on("targetcreated", async (t) => {
    if (t.type() !== "page") return;
    const pg = await t.page().catch(() => null);
    if (pg) await intercept(pg).catch(() => {});
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await intercept(page);

  const openFrame = async (pg, origin, lang) => {
    await pg.evaluate((o, src) => { window.FRAME_ORIGIN = o; window.open_(src); }, origin, B + "/shell.html" + (lang ? "?lang=" + lang : "") + "#" + NONCE);
    return until("the frame", () => pg.frames().find((f) => f.url().startsWith(B)));
  };
  await page.goto(A + "/", { waitUntil: "load" });
  await page.evaluate((b) => { window.FRAME_ORIGIN = b; }, B);
  let fr = await openFrame(page, B);
  await until("the frame's ready", () => page.evaluate(() => window.events.some((e) => e.t === "ready")));
  const st = (await page.evaluate(() => window.send("status")));
  if (!st || !st.ok || st.data.connected !== false) fail("status of a fresh frame: " + JSON.stringify(st));

  // 1. The frame runs only inside the origin it was rendered for.
  const top = await browser.newPage();
  await top.goto(B + "/shell.html#" + NONCE, { waitUntil: "load" });
  if (!(await top.evaluate(() => document.body.textContent)).startsWith("Refused: not framed")) fail("the frame ran as a top-level page");
  await top.close();
  const foreign = await browser.newPage(); // the same markup on another origin
  await foreign.goto(C + "/", { waitUntil: "load" });
  const ffr = await openFrame(foreign, B);
  await until("the refusal", async () => (await ffr.evaluate(() => document.body.textContent)).startsWith("Refused: framed by an unexpected origin"));
  const fsend = await foreign.evaluate(() => window.send("status"));
  if (fsend !== null) fail("the frame answered a page of an origin it was not rendered for: " + JSON.stringify(fsend));
  await foreign.close();
  out.origins = "refuses a top-level load and a frame under another origin";

  // 2. The page cannot read the frame (cross-origin), and the token is typed in the frame.
  const cross = await page.evaluate(() => {
    const f = document.getElementById("f");
    const r = {};
    try { void f.contentWindow.localStorage; r.storage = "readable"; } catch (e) { r.storage = e.name; }
    try { void f.contentWindow.document.body; r.document = "readable"; } catch (e) { r.document = e.name; }
    r.contentDocument = f.contentDocument === null ? "null" : "readable";
    return r;
  });
  if (cross.storage !== "SecurityError" || cross.document !== "SecurityError" || cross.contentDocument !== "null") fail("the page can reach the frame: " + JSON.stringify(cross));
  await fr.type("#tok", TOKEN);
  await fr.click("#connect");
  await until("GitHub connected", () => page.evaluate(() => window.events.some((e) => e.t === "state" && e.connected && e.forge === "github")));
  if ((await fr.$eval("#tok", (e) => e.value)) !== "") fail("the token field was not emptied");
  out.cross = "frame DOM and storage unreadable from the page";

  // 3. load, propose, refresh, for GitHub.
  let r = await page.evaluate(() => window.send("load", { repo: "o/r", dir: "talk" }));
  if (!r || !r.ok || r.data.base.commit !== headCommit || r.text["deck.md"] === undefined) fail("load: " + JSON.stringify(r));
  if (r.text["deck.md"] !== deck) fail("load brought other bytes");
  const base = r.data.base;
  const edited = deck + "\nmore\n";
  r = await page.evaluate((base, edited) => window.send("propose", { base, title: "Fix the deck", body: "from the test", files: { "deck.md": new TextEncoder().encode(edited), "new.md": new TextEncoder().encode("x") } }), base, edited);
  if (!r || !r.ok || r.data.url !== "https://github.com/o/r/pull/7" || !r.data.branch.startsWith("slides/fix-the-deck-")) fail("propose: " + JSON.stringify(r));
  const ref = calls.find((c) => c.method === "POST" && c.path === "/repos/o/r/git/refs");
  if (!ref || !JSON.parse(ref.body).ref.startsWith("refs/heads/slides/")) fail("the proposal did not make a new slides/ branch: " + JSON.stringify(ref));
  const pr = JSON.parse(calls.find((c) => c.path === "/repos/o/r/pulls").body);
  if (pr.base !== "main" || pr.title !== "Fix the deck" || pr.body !== "from the test") fail("the pull request: " + JSON.stringify(pr));
  if (calls.some((c) => c.method === "PATCH")) fail("a ref was moved");
  r = await page.evaluate((base) => window.send("refresh", { base }), base);
  if (!r || !r.ok || r.data.moved !== false) fail("refresh of an unmoved branch: " + JSON.stringify(r));
  headCommit = "9".repeat(40);
  r = await page.evaluate((base) => window.send("refresh", { base }), base);
  if (!r || !r.ok || r.data.moved !== true || r.data.base.commit !== headCommit || r.text["deck.md"] === undefined) fail("refresh of a moved branch: " + JSON.stringify(r));
  headCommit = "c".repeat(40);
  const gh = calls.filter((c) => c.host === "api.github.com");
  if (gh.length < 10) fail("expected the GitHub calls, got " + gh.length);
  for (const c of gh) if (c.auth !== "Bearer " + TOKEN) fail("a GitHub request without the token: " + c.path);
  out.github = gh.length + " requests, load + propose + refresh, each with the token in Authorization";

  // 4. Nothing the page can reach holds a token.
  const sweepPage = async () => page.evaluate(async () => {
    let s = "URL " + location.href + "\nCOOKIE " + document.cookie + "\n";
    for (const st of [localStorage, sessionStorage]) for (let i = 0; i < st.length; i++) s += st.key(i) + "=" + st.getItem(st.key(i)) + "\n";
    for (const i of await indexedDB.databases()) s += "IDB " + i.name + "\n";
    return s + (window.log || []).join("\n");
  });
  let swept = await sweepPage();
  if (leaks(swept)) fail("a token is in the page's storage, URL, cookies or messages");
  if (!swept.includes("From a fake forge")) fail("control: the message sweep should see the loaded deck");
  for (const c of calls) if (c.host !== "api.github.com" && c.host !== "gitlab.com") fail("a call to another host");
  const frameStore = await fr.evaluate(() => { let s = ""; for (let i = 0; i < localStorage.length; i++) s += localStorage.key(i) + "=" + localStorage.getItem(localStorage.key(i)); return s; });
  if (leaks(frameStore)) fail("without Remember the frame stored a token");
  out.nowhere = "not in the page's storage, URL, cookies or any message; not in the frame's storage unless asked";

  // 5. Off-schema, wrongly nonced and foreign-window messages are ignored or refused.
  const bad = await page.evaluate(async () => ({
    unknown: await window.send("token", {}),
    extra: await window.send("load", { repo: "o/r", token: "x" }),
    type: await window.send("load", { repo: 5 }),
    bigdir: await window.send("load", { repo: "o/r", dir: "d".repeat(2000) }),
    badrepo: await window.send("load", { repo: "../etc" }),
    base: await window.send("propose", { base: { forge: "github" }, title: "t", files: {} }),
    files: await window.send("propose", { base: { forge: "github", repo: "o/r", ref: "main", commit: "c".repeat(40) }, title: "t", files: { "a": "text" } }),
    wrongNonce: await window.send("status", {}, "wrong"),
    noNonce: await window.send("status", {}, null),
  }));
  for (const k of ["unknown", "extra", "type", "bigdir", "base", "files"]) if (!bad[k] || bad[k].ok !== false) fail("a malformed command was accepted: " + k + " " + JSON.stringify(bad[k]));
  if (!bad.badrepo || bad.badrepo.ok !== false) fail("the module accepted a bad repository name");
  if (bad.wrongNonce !== null || bad.noNonce !== null) fail("a command without the nonce was answered");
  await page.evaluate(() => { window.__n = window.log.length; window.sib = document.getElementById("sib").contentWindow; });
  await page.evaluate(() => window.sib.attack({ t: "status", id: "x1", nonce: NONCE }));
  await sleep(400);
  if (await page.evaluate(() => window.log.slice(window.__n).some((m) => m.includes('"x1"')))) fail("the frame answered a message from another window of the same origin");
  out.schema = "unknown, extra, mistyped, oversize, wrongly nonced and foreign-window commands refused or ignored";

  // 6. Remember on this device: the frame's localStorage, only on request, gone on Disconnect.
  r = await page.evaluate(() => window.send("disconnect"));
  if (!r.ok || r.data.connected) fail("disconnect: " + JSON.stringify(r));
  await fr.click("#remember");
  await fr.type("#tok", TOKEN);
  await fr.click("#connect");
  await until("the token kept", () => fr.evaluate((t) => { const k = JSON.parse(localStorage.getItem("goSlidesKeptToken") || "null"); return k && k.v === 1 && k.forge === "github" && k.token === t; }, TOKEN));
  fr = await openFrame(page, B); // a reload: it connects at once, for the forge it was kept for
  await until("reconnected from the device", () => page.evaluate(() => window.events.some((e) => e.t === "ready" && e.connected && e.forge === "github" && e.remembered)));
  swept = await sweepPage();
  if (leaks(swept)) fail("the page can see the kept token");
  r = await page.evaluate(() => window.send("load", { repo: "o/r", dir: "talk" }));
  if (!r || !r.ok) fail("load after reconnecting: " + JSON.stringify(r));
  await fr.click("#disconnect");
  await until("the token forgotten", () => fr.evaluate(() => localStorage.getItem("goSlidesKeptToken") === null));
  out.remember = "kept only on request, in the frame's storage; reload reconnects; Disconnect removes it";

  // 7. The frame's own CSP: no fetch to another host.
  const blocked = await fr.evaluate(async () => { try { await fetch("https://example.com/steal"); return false; } catch (_) { return true; } });
  if (!blocked) fail("the frame could fetch https://example.com");
  out.csp = "connect-src refuses other hosts";

  // 8. GitLab with a personal access token.
  fr = await openFrame(page, B);
  await until("a fresh frame", () => page.evaluate(() => window.events.filter((e) => e.t === "ready").length >= 1));
  await fr.select("#forge", "gitlab");
  await fr.type("#tok", GL_TOKEN);
  await fr.click("#connect");
  await until("GitLab connected", () => page.evaluate(() => window.events.some((e) => e.t === "state" && e.connected && e.forge === "gitlab")));
  r = await page.evaluate(() => window.send("load", { repo: "g/p", dir: "talk" }));
  if (!r || !r.ok || r.text["deck.md"] === undefined || r.data.base.forge !== "gitlab") fail("GitLab load: " + JSON.stringify(r));
  r = await page.evaluate((base) => window.send("propose", { base, title: "A change", body: "b", files: { "deck.md": new TextEncoder().encode("changed") } }), r.data.base);
  if (!r || !r.ok || r.data.url !== "https://gitlab.com/g/p/-/merge_requests/3" || !r.data.branch.startsWith("slides/a-change-")) fail("GitLab propose: " + JSON.stringify(r));
  const commitCall = JSON.parse(calls.find((c) => c.host === "gitlab.com" && c.path.endsWith("/repository/commits")).body);
  if (commitCall.force !== false || commitCall.branch === "main" || !commitCall.branch.startsWith("slides/")) fail("GitLab commit: " + JSON.stringify(commitCall));
  for (const c of calls.filter((c) => c.host === "gitlab.com" && c.path.startsWith("/api/"))) if (c.auth !== "Bearer " + GL_TOKEN) fail("a GitLab request without the token: " + c.path);
  r = await page.evaluate(() => window.send("disconnect"));
  out.gitlab = "load + propose with a personal access token, a new slides/ branch, never forced";

  // 9. GitLab's redirect sign-in: a popup, PKCE, the page never involved.
  fr = await openFrame(page, B);
  await until("a fresh frame", () => page.evaluate(() => window.events.filter((e) => e.t === "ready").length >= 1));
  await fr.select("#forge", "gitlab");
  await until("the sign-in button", async () => !(await fr.$eval("#signin", (e) => e.hidden)));
  // A popup opens before a script can hook its first request, so the test takes
  // window.open's URL and navigates a pre-hooked page to it, as the popup would.
  await fr.evaluate(() => { window.open = (u, name, features) => { window.__popup = { u, name, features }; return null; }; });
  await fr.click("#signin");
  const pop = await until("the popup", () => fr.evaluate(() => window.__popup));
  if (!pop.u.startsWith("https://gitlab.com/oauth/authorize?") || !/popup/.test(pop.features)) fail("the sign-in popup: " + JSON.stringify(pop));
  const ppage = await browser.newPage();
  await intercept(ppage);
  await ppage.goto(pop.u, { waitUntil: "load" }).catch(() => {});
  await until("the sign-in state", () => page.evaluate(() => window.events.some((e) => e.t === "state" && e.connected && e.forge === "gitlab" && e.oauth)));
  if (!oauthState || tokenRequests.length !== 1) fail("the token exchange did not happen once: " + tokenRequests.length);
  if (tokenRequests[0].redirect_uri !== B + "/callback.html" || tokenRequests[0].client_id !== "test-client-id") fail("the exchange: " + JSON.stringify(tokenRequests[0]));
  if (new URL(redirectURI).origin !== B) fail("the redirect URI is not the frame's origin: " + redirectURI);
  if (await fr.evaluate(() => localStorage.getItem("goSlidesOAuthAttempt") !== null)) fail("the attempt was left in storage");
  await ppage.close().catch(() => {});
  r = await page.evaluate(() => window.send("load", { repo: "g/p", dir: "talk" }));
  if (!r || !r.ok) fail("load after sign-in: " + JSON.stringify(r));
  const last = calls.filter((c) => c.host === "gitlab.com" && c.path.startsWith("/api/")).pop();
  if (last.auth !== "Bearer " + ACCESS) fail("the signed-in call did not carry the access token: " + last.auth);
  swept = await sweepPage();
  if (leaks(swept)) fail("the page saw an OAuth token or code");
  if ((await fr.evaluate(() => localStorage.getItem("goSlidesKeptToken"))) !== null) fail("a sign-in was kept without being asked");
  await fr.click("#disconnect");
  await until("the revoke", () => revokes.length === 2);
  if (!revokes.every((b) => b.includes("client_id=test-client-id"))) fail("revoke: " + revokes);
  out.signin = "popup, PKCE (S256 challenge matched the verifier), state checked, tokens never in the page, revoked on Disconnect";

  // 10. Localised, and no page error.
  const fr2 = await openFrame(page, B, "fr");
  await until("the French frame", async () => (await fr2.$eval("#connect", (e) => e.textContent)) === "Connecter");
  if (errors.length) fail("page errors: " + errors.join("; "));
  out.lang = "fr";

  console.log("FRAME_OK " + JSON.stringify(out));
  await browser.close();
  for (const s of [parent, other, framesite]) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => fail(e.stack || String(e)));
