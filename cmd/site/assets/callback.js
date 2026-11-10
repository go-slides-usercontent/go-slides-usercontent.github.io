// GitLab's redirect lands here, in the popup the frame opened. This page holds
// no token and runs no module: it hands its own URL (the code and the state) to
// the frame's document over a same-origin BroadcastChannel, removes them from
// its address bar and closes. The frame checks the state against the attempt it
// begun and trades the code (PKCE) itself.
(function () {
  "use strict";
  const url = location.href;
  history.replaceState(null, "", location.pathname);
  if (typeof BroadcastChannel === "function") {
    const ch = new BroadcastChannel("goSlidesSignIn");
    ch.postMessage({ url: url });
    ch.close();
  }
  window.close();
})();
