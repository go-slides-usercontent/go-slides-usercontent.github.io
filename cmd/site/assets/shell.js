// The git frame of the go-slides playground, on its second origin.
//
// It holds the forge token and runs the forge calls (frame.wasm, from package
// frame). The playground page, another site, can send it typed commands and
// read their results; it can never read the token, because the token is typed
// into an input of THIS document, lives in this origin's memory and, only if the
// person ticks "Remember on this device", in this origin's localStorage.
//
// It talks to exactly the origins in ALLOW, written in at render time and
// checked by `secondorigin verify` against the playground's .second-origin.json.
// A message is believed only when its origin is in ALLOW, its source is the
// framing window, and it carries the nonce of this page's URL fragment (which
// only the framing page knows). Replies go to the origin that asked; the frame
// refuses to run unless the page that frames it is in ALLOW. Commands:
//
//   status {}                         -> {connected, forge, oauth}
//   load {repo, ref, dir}             -> {base} + files
//   propose {base, title, body} + files -> {branch, commit, url}
//   refresh {base}                    -> {base, moved} + files when moved
//   disconnect {}                     -> {connected:false}
//
// Every command is checked against a schema (unknown fields, wrong types and
// over-size values are refused) before it reaches the module, which checks it
// again. There is no command that takes or returns a token, and none that signs
// in: both happen in this document.
(function () {
  "use strict";
  const ALLOW = @@ALLOW@@;
  const GITLAB_CLIENT_ID = "@@GITLAB_CLIENT_ID@@";
  const KEPT = "goSlidesKeptToken";
  const ATTEMPT = "goSlidesOAuthAttempt";
  const CHANNEL = "goSlidesSignIn";
  const MAX_FILES = 2000, MAX_FILE = 20 << 20, MAX_TOTAL = 100 << 20;

  const nonce = location.hash.slice(1);
  history.replaceState(null, "", location.pathname + location.search);

  const L = (function () {
    const en = {
      forge: "Forge", token: "Access token", remember: "Remember on this device",
      connect: "Connect", signin: "Sign in with GitLab", disconnect: "Disconnect",
      off: "Not connected.", on: "Connected.", kept: "Connected; the token is kept on this device.",
      failed: "Failed: ", refused: "Refused: ",
    };
    const t = {
      en,
      fr: { forge: "Forge", token: "Jeton d'accès", remember: "Se souvenir sur cet appareil", connect: "Connecter", signin: "Se connecter avec GitLab", disconnect: "Déconnecter", off: "Non connecté.", on: "Connecté.", kept: "Connecté ; le jeton est gardé sur cet appareil.", failed: "Échec : ", refused: "Refusé : " },
      de: { forge: "Forge", token: "Zugriffstoken", remember: "Auf diesem Gerät merken", connect: "Verbinden", signin: "Mit GitLab anmelden", disconnect: "Trennen", off: "Nicht verbunden.", on: "Verbunden.", kept: "Verbunden; das Token bleibt auf diesem Gerät.", failed: "Fehlgeschlagen: ", refused: "Abgelehnt: " },
      es: { forge: "Forja", token: "Token de acceso", remember: "Recordar en este dispositivo", connect: "Conectar", signin: "Iniciar sesión con GitLab", disconnect: "Desconectar", off: "No conectado.", on: "Conectado.", kept: "Conectado; el token se guarda en este dispositivo.", failed: "Error: ", refused: "Rechazado: " },
      it: { forge: "Forge", token: "Token di accesso", remember: "Ricorda su questo dispositivo", connect: "Connetti", signin: "Accedi con GitLab", disconnect: "Disconnetti", off: "Non connesso.", on: "Connesso.", kept: "Connesso; il token resta su questo dispositivo.", failed: "Errore: ", refused: "Rifiutato: " },
      pt: { forge: "Forja", token: "Token de acesso", remember: "Lembrar neste dispositivo", connect: "Conectar", signin: "Entrar com o GitLab", disconnect: "Desconectar", off: "Não conectado.", on: "Conectado.", kept: "Conectado; o token fica neste dispositivo.", failed: "Falhou: ", refused: "Recusado: " },
      pl: { forge: "Forge", token: "Token dostępu", remember: "Zapamiętaj na tym urządzeniu", connect: "Połącz", signin: "Zaloguj przez GitLab", disconnect: "Rozłącz", off: "Niepołączony.", on: "Połączono.", kept: "Połączono; token zostaje na tym urządzeniu.", failed: "Błąd: ", refused: "Odrzucono: " },
      ru: { forge: "Форж", token: "Токен доступа", remember: "Запомнить на этом устройстве", connect: "Подключить", signin: "Войти через GitLab", disconnect: "Отключить", off: "Не подключено.", on: "Подключено.", kept: "Подключено; токен хранится на этом устройстве.", failed: "Ошибка: ", refused: "Отклонено: " },
      uk: { forge: "Форж", token: "Токен доступу", remember: "Запам'ятати на цьому пристрої", connect: "Підключити", signin: "Увійти через GitLab", disconnect: "Відключити", off: "Не підключено.", on: "Підключено.", kept: "Підключено; токен зберігається на цьому пристрої.", failed: "Помилка: ", refused: "Відхилено: " },
      ja: { forge: "フォージ", token: "アクセストークン", remember: "このデバイスに保存", connect: "接続", signin: "GitLab でサインイン", disconnect: "切断", off: "未接続。", on: "接続しました。", kept: "接続しました。トークンはこのデバイスに保存されます。", failed: "失敗: ", refused: "拒否: " },
      ko: { forge: "포지", token: "액세스 토큰", remember: "이 기기에 기억", connect: "연결", signin: "GitLab으로 로그인", disconnect: "연결 해제", off: "연결되지 않음.", on: "연결됨.", kept: "연결됨. 토큰은 이 기기에 저장됩니다.", failed: "실패: ", refused: "거부됨: " },
      zh: { forge: "代码托管", token: "访问令牌", remember: "在此设备上记住", connect: "连接", signin: "使用 GitLab 登录", disconnect: "断开", off: "未连接。", on: "已连接。", kept: "已连接；令牌保存在此设备上。", failed: "失败：", refused: "已拒绝：" },
    };
    const q = new URLSearchParams(location.search).get("lang") || navigator.language || "en";
    return t[q.slice(0, 2).toLowerCase()] || en;
  })();

  const $ = (id) => document.getElementById(id);
  function refuse(why) {
    document.body.textContent = L.refused + why;
  }

  // ---- who frames us -------------------------------------------------------
  if (window.parent === window) { return refuse("not framed"); }
  if (!/^[A-Za-z0-9_-]{16,}$/.test(nonce)) { return refuse("no nonce"); }
  const anc = location.ancestorOrigins;
  let from;
  if (anc && anc.length) {
    from = anc.length === 1 ? anc[0] : "";
  } else {
    try { from = new URL(document.referrer).origin; } catch (e) { from = ""; }
  }
  if (ALLOW.indexOf(from) < 0) { return refuse("framed by an unexpected origin"); }

  $("l-forge").textContent = L.forge;
  $("l-tok").textContent = L.token;
  $("l-remember").textContent = L.remember;
  $("connect").textContent = L.connect;
  $("signin").textContent = L.signin;
  $("disconnect").textContent = L.disconnect;
  document.documentElement.lang = new URLSearchParams(location.search).get("lang") || document.documentElement.lang;

  // ---- the module ----------------------------------------------------------
  globalThis.goFrameConfig = { gitlabClientID: GITLAB_CLIENT_ID, redirectURI: location.origin + "/callback.html" };
  let ready;
  const loaded = new Promise((r) => { ready = r; });
  (async function () {
    const go = new Go();
    let inst;
    try {
      inst = await WebAssembly.instantiateStreaming(fetch("frame.wasm"), go.importObject);
    } catch (e) {
      const b = await (await fetch("frame.wasm")).arrayBuffer();
      inst = await WebAssembly.instantiate(b, go.importObject);
    }
    go.run(inst.instance);
    for (let i = 0; i < 400 && !globalThis.goFrame; i++) { await new Promise((r) => setTimeout(r, 25)); }
    ready(globalThis.goFrame);
  })().catch((e) => ready(null));

  // call runs one op in the module; the result's JSON is parsed here.
  async function call(op, args, files) {
    const f = await loaded;
    if (!f) { throw new Error("module not loaded"); }
    const r = await f.call(op, JSON.stringify(args || {}), files);
    return { data: JSON.parse(r.json), files: r.files };
  }

  // ---- state and the person's own controls ---------------------------------
  let state = { connected: false, forge: "", oauth: false };
  let remembered = false;

  function say(s) { $("status").textContent = s; }
  function paint() {
    $("connect").disabled = state.connected;
    $("disconnect").disabled = !state.connected;
    $("forge").disabled = state.connected;
    $("tok").disabled = state.connected;
    if (state.forge) { $("forge").value = state.forge; }
    $("signin").hidden = !(globalThis.goFrame && globalThis.goFrame.oauth) || $("forge").value !== "gitlab";
    say(state.connected ? (remembered ? L.kept : L.on) : L.off);
  }
  function announce() {
    window.parent.postMessage({ t: "state", connected: state.connected, forge: state.forge, oauth: state.oauth, remembered: remembered }, from);
  }
  function setState(d) {
    state = { connected: !!d.connected, forge: d.forge || "", oauth: !!d.oauth };
    paint();
    announce();
  }
  function storage() { try { return window.localStorage; } catch (e) { return null; } }
  function keep(forge, token) {
    const s = storage();
    if (s) { try { s.setItem(KEPT, JSON.stringify({ v: 1, forge: forge, token: token })); } catch (e) { /* full or blocked */ } }
  }
  function unkeep() {
    const s = storage();
    if (s) { try { s.removeItem(KEPT); } catch (e) { /* blocked */ } }
  }

  async function connect(forge, token, remember) {
    try {
      const r = await call("connect", { Forge: forge, Token: token });
      remembered = !!remember;
      if (remembered) { keep(forge, token); }
      setState(r.data);
    } catch (e) {
      say(L.failed + e.message);
    }
  }

  $("connect").addEventListener("click", function () {
    const tok = $("tok").value;
    $("tok").value = ""; // the field, and so its text, empty at once
    connect($("forge").value, tok, $("remember").checked);
  });
  $("remember").addEventListener("change", function () {
    if (!$("remember").checked) { unkeep(); remembered = false; paint(); announce(); }
  });
  $("forge").addEventListener("change", paint);
  $("disconnect").addEventListener("click", async function () {
    try { await call("disconnect"); } catch (e) { /* the module forgets regardless */ }
    unkeep();
    remembered = false;
    setState({ connected: false });
  });

  // GitLab's redirect sign-in: a popup of this origin, back at /callback.html,
  // which hands the callback URL to this document over a BroadcastChannel (same
  // origin only). The attempt waits in this origin's storage until it does.
  $("signin").addEventListener("click", async function () {
    try {
      const r = await call("signin-begin");
      const s = storage();
      if (s) { s.setItem(ATTEMPT, JSON.stringify(r.data.attempt)); }
      window.open(r.data.url, "goSlidesSignIn", "popup,width=520,height=720");
    } catch (e) {
      say(L.failed + e.message);
    }
  });
  if (typeof BroadcastChannel === "function") {
    new BroadcastChannel(CHANNEL).onmessage = async function (e) {
      const s = storage();
      let attempt = null;
      if (s) {
        try { attempt = JSON.parse(s.getItem(ATTEMPT)); s.removeItem(ATTEMPT); } catch (x) { attempt = null; }
      }
      if (!attempt || !e.data || typeof e.data.url !== "string") { return; }
      try {
        const r = await call("signin-finish", { Attempt: attempt, URL: e.data.url });
        remembered = false;
        setState(r.data);
      } catch (x) {
        say(L.failed + x.message);
      }
    };
  }

  // a token kept on this device connects at once, for the forge it was kept for
  (async function () {
    await loaded;
    const s = storage();
    let k = null;
    if (s) { try { k = JSON.parse(s.getItem(KEPT)); } catch (e) { k = null; } }
    if (k && k.v === 1 && (k.forge === "github" || k.forge === "gitlab") && typeof k.token === "string") {
      await connect(k.forge, k.token, true);
      $("remember").checked = remembered;
    } else if (k) {
      unkeep();
    }
    paint();
    window.parent.postMessage({ t: "ready", connected: state.connected, forge: state.forge, oauth: state.oauth, remembered: remembered }, from);
  })();

  // ---- the page's commands -------------------------------------------------
  const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
  const only = (o, keys) => Object.keys(o).every((k) => keys.indexOf(k) >= 0);
  const str = (v, max) => typeof v === "string" && v.length <= max;
  function checkBase(b) {
    if (!isObj(b) || !only(b, ["forge", "repo", "ref", "dir", "commit", "blobs"])) { return false; }
    for (const k of ["forge", "repo", "ref", "commit"]) { if (!str(b[k], 300)) { return false; } }
    if (b.dir !== undefined && !str(b.dir, 1024)) { return false; }
    if (b.blobs !== undefined) {
      if (!isObj(b.blobs) || Object.keys(b.blobs).length > MAX_FILES) { return false; }
      for (const p of Object.keys(b.blobs)) { if (p.length > 1024 || !str(b.blobs[p], 64)) { return false; } }
    }
    return true;
  }
  function checkFiles(f) {
    if (!isObj(f)) { return null; }
    const keys = Object.keys(f);
    if (keys.length > MAX_FILES) { return null; }
    const out = Object.create(null);
    let total = 0;
    for (const k of keys) {
      let v = f[k];
      if (v instanceof ArrayBuffer) { v = new Uint8Array(v); }
      if (!(v instanceof Uint8Array) || k.length > 1024 || v.length > MAX_FILE) { return null; }
      total += v.length;
      if (total > MAX_TOTAL) { return null; }
      out[k] = v;
    }
    return out;
  }
  // schemas: command -> [allowed fields, validator of the arguments, op, module args]
  const COMMANDS = {
    status: { fields: [], ok: () => true },
    disconnect: { fields: [], ok: () => true },
    load: {
      fields: ["repo", "ref", "dir"],
      ok: (m) => str(m.repo, 300) && (m.ref === undefined || str(m.ref, 200)) && (m.dir === undefined || str(m.dir, 1024)),
    },
    propose: {
      fields: ["base", "files", "title", "body"],
      ok: (m) => checkBase(m.base) && checkFiles(m.files) !== null && str(m.title, 600) && (m.body === undefined || str(m.body, 4096)),
    },
    refresh: { fields: ["base"], ok: (m) => checkBase(m.base) },
  };

  function reply(e, m, ok, data, files) {
    const msg = { t: "result", id: m.id, cmd: m.t, ok: ok };
    const transfer = [];
    if (ok) {
      msg.data = data;
      if (files) {
        msg.files = {};
        for (const p of Object.keys(files)) { msg.files[p] = files[p]; transfer.push(files[p].buffer); }
      }
    } else {
      msg.error = String(data);
    }
    e.source.postMessage(msg, e.origin, transfer);
  }

  async function run(m) {
    switch (m.t) {
      case "status": return { data: state };
      case "disconnect":
        try { await call("disconnect"); } catch (e) { /* forgotten regardless */ }
        unkeep(); remembered = false; setState({ connected: false });
        return { data: state };
      case "load": {
        const r = await call("load", { Repo: m.repo, Ref: m.ref || "", Dir: m.dir || "" });
        const files = {};
        for (const p of Object.keys(r.files || {})) { files[p] = r.files[p]; }
        return { data: { base: r.data }, files: files };
      }
      case "propose": {
        const r = await call("propose", { Base: baseOut(m.base), Title: m.title, Body: m.body || "" }, checkFiles(m.files));
        return { data: r.data };
      }
      case "refresh": {
        const r = await call("refresh", baseOut(m.base));
        return r.data.moved ? { data: { base: r.data.base, moved: true }, files: r.files } : { data: { base: r.data.base, moved: false } };
      }
    }
    throw new Error("unknown command");
  }
  // the module's JSON field names are Go's
  function baseOut(b) {
    return { Forge: b.forge, Repo: b.repo, Ref: b.ref, Dir: b.dir || "", Commit: b.commit, Blobs: b.blobs || {} };
  }

  window.addEventListener("message", async function (e) {
    if (ALLOW.indexOf(e.origin) < 0 || e.source !== window.parent) { return; }
    const m = e.data;
    if (!isObj(m) || m.nonce !== nonce || typeof m.t !== "string" || !str(m.id, 64)) { return; }
    const c = Object.prototype.hasOwnProperty.call(COMMANDS, m.t) ? COMMANDS[m.t] : null;
    if (!c) { return reply(e, m, false, "unknown command"); }
    if (!only(m, ["t", "id", "nonce"].concat(c.fields)) || !c.ok(m)) { return reply(e, m, false, "malformed command"); }
    try {
      const r = await run(m);
      reply(e, m, true, r.data, r.files);
    } catch (x) {
      reply(e, m, false, x && x.message || x);
    }
  });
})();
