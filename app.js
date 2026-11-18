(() => {
  "use strict";

  // Public endpoint, not a credential. Fill this in after deploying the Worker.
  // Keep the empty value until the authenticated end-to-end flow is verified.
  const BRIDGE_URL = "https://youtubesum-submit.csibi-levente14.workers.dev";
  const OWNER_ACTIONS_URL = "https://github.com/leweex95/youtubesum/actions/workflows/summarize.yml";

  const form = document.getElementById("request-form");
  const input = document.getElementById("video-url");
  const signInButton = document.getElementById("sign-in");
  const signOutButton = document.getElementById("sign-out");
  const submitButton = document.getElementById("submit-request");
  const note = document.getElementById("setup-note");
  const badge = document.getElementById("bridge-badge");

  let bridgeOrigin = null;
  let sessionToken = null;
  let sessionExpiresAt = 0;
  let authPopup = null;
  let popupMonitor = null;
  let busy = false;

  try {
    if (BRIDGE_URL) {
      const bridge = new URL(BRIDGE_URL);
      if (bridge.protocol === "https:" && bridge.pathname === "/" && !bridge.search && !bridge.hash) {
        bridgeOrigin = bridge.origin;
      }
    }
  } catch {
    bridgeOrigin = null;
  }

  function setMessage(message, state = "") {
    note.replaceChildren(document.createTextNode(message));
    note.dataset.state = state;
  }

  function setBadge(message, state = "") {
    badge.replaceChildren(document.createTextNode("● " + message));
    badge.dataset.state = state;
  }

  function setAuthenticated(token, expiresAt) {
    sessionToken = token;
    sessionExpiresAt = expiresAt;
    signInButton.hidden = true;
    signOutButton.hidden = false;
    input.disabled = false;
    submitButton.disabled = busy;
    setBadge("OWNER SIGNED IN", "ready");
    setMessage("Signed in for this browser session. The Windows runner must be online; queued jobs may expire after about 24 hours.", "success");
  }

  function clearSession(message = "Sign in with the owner’s GitHub account to submit a request.") {
    sessionToken = null;
    sessionExpiresAt = 0;
    signInButton.disabled = busy;
    signInButton.hidden = false;
    signOutButton.hidden = true;
    input.disabled = true;
    submitButton.disabled = true;
    if (bridgeOrigin) {
      setBadge("SIGN IN REQUIRED");
      setMessage(message);
    }
  }

  function ensureSession() {
    if (sessionToken && Date.now() < sessionExpiresAt) return true;
    clearSession("Your short-lived sign-in expired. Sign in again before submitting.");
    return false;
  }

  function normalizeVideoUrl(value) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const videoHosts = new Set([
      "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
      "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be", "www.youtu.be",
    ]);
    if (!videoHosts.has(host) || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error("Enter a standard YouTube video URL.");
    }
    if (url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))) {
      throw new Error("Enter a YouTube URL using a standard web port.");
    }

    let videoId = "";
    if (host === "youtu.be" || host === "www.youtu.be") {
      const match = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
      if (match) videoId = match[1];
    } else if (url.pathname === "/watch") {
      const ids = url.searchParams.getAll("v");
      if (ids.length === 1 && !url.searchParams.has("list") && /^[A-Za-z0-9_-]{11}$/.test(ids[0])) {
        videoId = ids[0];
      }
    } else {
      const match = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
      if (match) videoId = match[1];
    }
    if (!videoId) throw new Error("Enter one supported video link; playlists are not accepted.");
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  function finishPopupMonitor() {
    if (popupMonitor !== null) window.clearInterval(popupMonitor);
    popupMonitor = null;
    authPopup = null;
  }

  function onAuthMessage(event) {
    if (!bridgeOrigin || event.origin !== bridgeOrigin || event.source !== authPopup) return;
    const data = event.data;
    window.removeEventListener("message", onAuthMessage);
    finishPopupMonitor();
    if (!data || data.type !== "youtubesum-auth") return;
    if (data.ok === true && typeof data.token === "string" && data.token.length < 4096 &&
        Number.isSafeInteger(data.expiresAt) && data.expiresAt > Date.now()) {
      setAuthenticated(data.token, data.expiresAt);
      return;
    }
    clearSession("GitHub sign-in did not complete. Please try again.");
    setBadge("SIGN IN FAILED", "error");
  }

  function startSignIn() {
    if (!bridgeOrigin || busy) return;
    const signInUrl = new URL("/auth/start", bridgeOrigin);
    authPopup = window.open(signInUrl.href, "youtubesum-github-signin", "popup,width=520,height=680");
    if (!authPopup) {
      setMessage("Your browser blocked the sign-in window. Allow popups for this site and try again.", "error");
      return;
    }
    window.addEventListener("message", onAuthMessage);
    setMessage("Complete the GitHub sign-in in the new window…");
    popupMonitor = window.setInterval(() => {
      if (authPopup && authPopup.closed) {
        window.removeEventListener("message", onAuthMessage);
        finishPopupMonitor();
        if (!sessionToken) setMessage("Sign-in window closed. Sign in to submit a request.");
      }
    }, 500);
  }

  function showAccepted() {
    const text = document.createTextNode("Request accepted by GitHub. The Windows runner must be online; an offline queued job may expire after about 24 hours. ");
    const link = document.createElement("a");
    link.href = OWNER_ACTIONS_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Check private Actions status";
    note.replaceChildren(text, link);
    note.dataset.state = "success";
    setBadge("REQUEST ACCEPTED", "ready");
  }

  function consumeAuthHandoff() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("bridge_session");
    const expiresAt = Number(params.get("expires"));
    const error = params.get("bridge_error");
    if (!token && !error) return false;

    // The fragment is never sent to GitHub Pages or included in a referrer.
    // Remove it from the address bar/history immediately after reading it.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (token && token.length < 4096 && Number.isSafeInteger(expiresAt) && expiresAt > Date.now()) {
      setAuthenticated(token, expiresAt);
    } else if (error === "account_not_allowed") {
      setBadge("ACCOUNT NOT ALLOWED", "error");
      setMessage("Sign in with the owner’s GitHub account to submit a request.", "error");
    } else {
      setBadge("SIGN IN FAILED", "error");
      setMessage("GitHub sign-in did not complete. Please try again.", "error");
    }
    return true;
  }

  async function submitRequest(event) {
    event.preventDefault();
    if (!ensureSession() || busy) return;

    let youtubeUrl;
    try {
      youtubeUrl = normalizeVideoUrl(input.value.trim());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enter a valid YouTube video URL.", "error");
      input.focus();
      return;
    }

    busy = true;
    submitButton.disabled = true;
    signInButton.disabled = true;
    setMessage("Sending a private workflow request…");
    try {
      const response = await fetch(`${bridgeOrigin}/api/dispatch`, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Authorization": `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ youtube_url: youtubeUrl }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        clearSession("Your sign-in expired. Sign in again before submitting.");
      } else if (response.status === 429) {
        setMessage("A request was submitted recently. Wait a moment before trying again.", "error");
      } else if (!response.ok || result.ok !== true) {
        setMessage("The secure bridge could not submit the request. Please try again later.", "error");
      } else {
        input.value = "";
        showAccepted();
      }
    } catch {
      setMessage("Could not reach the secure bridge. Check your connection and try again.", "error");
    } finally {
      busy = false;
      signInButton.disabled = false;
      submitButton.disabled = !ensureSession();
    }
  }

  signInButton.addEventListener("click", startSignIn);
  signOutButton.addEventListener("click", () => clearSession("Signed out. Sign in again to submit another request."));
  form.addEventListener("submit", submitRequest);

  if (!bridgeOrigin) {
    signInButton.disabled = true;
    input.disabled = true;
    submitButton.disabled = true;
    setBadge("BRIDGE SETUP REQUIRED");
    setMessage("The authenticated bridge has not been configured yet.");
  } else {
    signInButton.disabled = false;
    if (!consumeAuthHandoff()) clearSession();
  }
})();
