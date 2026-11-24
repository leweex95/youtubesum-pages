(() => {
  "use strict";

  // Enable owner-only dispatch after the private processing-to-email flow passed
  // end-to-end verification. The Worker still enforces owner authentication.
  const BRIDGE_URL = "https://youtubesum-submit.csibi-levente14.workers.dev";
  const SUBMISSIONS_ENABLED = true;
  const OWNER_ACTIONS_URL = "https://github.com/leweex95/youtubesum/actions/workflows/summarize.yml";
  const AUDIO_LANGUAGES = new Set(["en", "ar", "da", "de", "el", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh"]);

  const form = document.getElementById("request-form");
  const input = document.getElementById("video-url");
  const signInButton = document.getElementById("sign-in");
  const signOutButton = document.getElementById("sign-out");
  const submitButton = document.getElementById("submit-request");
  const note = document.getElementById("setup-note");
  const badge = document.getElementById("bridge-badge");
  const modeSelect = document.getElementById("summary-mode");
  const languageInput = document.getElementById("output-language");
  const formats = document.getElementById("summary-formats");
  const promptEditor = document.getElementById("prompt-editor");
  const promptList = document.getElementById("prompt-list");
  const progressPanel = document.getElementById("progress-panel");
  const progressSpinner = document.getElementById("progress-spinner");
  const progressTitle = document.getElementById("progress-title");
  const progressFeed = document.getElementById("progress-feed");
  const cancelButton = document.getElementById("cancel-request");
  const actionsLink = document.getElementById("actions-link");
  const requestTab = document.getElementById("request-tab");
  const libraryTab = document.getElementById("library-tab");
  const requestView = document.getElementById("request-view");
  const libraryView = document.getElementById("library-view");
  const libraryStatus = document.getElementById("library-status");
  const librarySearch = document.getElementById("library-search");
  const libraryKeywordsElement = document.getElementById("library-keywords");
  const libraryCount = document.getElementById("library-count");
  const libraryList = document.getElementById("library-list");
  const loadMoreLibrary = document.getElementById("load-more-library");
  const refreshLibrary = document.getElementById("refresh-library");
  const libraryDetail = document.getElementById("library-detail");
  const libraryDetailTitle = document.getElementById("library-detail-title");
  const libraryVideoLink = document.getElementById("library-video-link");
  const libraryDetailKeywords = document.getElementById("library-detail-keywords");
  const libraryFormat = document.getElementById("library-format");
  const librarySummary = document.getElementById("library-summary");

  let bridgeOrigin = null;
  let sessionToken = null;
  let sessionExpiresAt = 0;
  let authPopup = null;
  let popupMonitor = null;
  let busy = false;
  let trackingJob = false;
  let cancelToken = null;
  let activeStatusToken = null;
  let cancellationRequested = false;
  let promptTemplates = {};
  let activeRequestId = null;
  let pollTimer = null;
  const seenProgress = new Set();
  const libraryRows = [];
  const activeKeywordFilters = new Set();
  let libraryKeywords = [];
  let libraryNextOffset = null;
  let libraryTotal = 0;
  let libraryLoaded = false;
  let activeLibraryItem = null;

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
    libraryTab.disabled = false;
    libraryTab.textContent = "Knowledge bank";
    input.disabled = !SUBMISSIONS_ENABLED;
    modeSelect.disabled = !SUBMISSIONS_ENABLED;
    languageInput.disabled = !SUBMISSIONS_ENABLED;
    formats.disabled = !SUBMISSIONS_ENABLED;
    submitButton.disabled = !SUBMISSIONS_ENABLED || busy || trackingJob;
    setBadge("OWNER SIGNED IN", "ready");
    setMessage(SUBMISSIONS_ENABLED
      ? "Signed in for this browser session. The Windows runner must be online; queued jobs may expire after about 24 hours."
      : "GitHub sign-in verified. Submissions remain paused until private processing and MP3 email delivery pass an end-to-end check.", "success");
    void loadPromptTemplates();
    void loadLibrary(true);
  }

  function clearSession(message = "Sign in with the owner’s GitHub account to submit a request.") {
    sessionToken = null;
    sessionExpiresAt = 0;
    signInButton.disabled = busy;
    signInButton.hidden = false;
    signOutButton.hidden = true;
    libraryTab.disabled = true;
    libraryTab.textContent = "Knowledge bank · sign in";
    input.disabled = true;
    modeSelect.disabled = true;
    languageInput.disabled = true;
    formats.disabled = true;
    submitButton.disabled = true;
    promptTemplates = {};
    promptList.replaceChildren();
    promptEditor.hidden = true;
    clearLibrary();
    switchView("request");
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
    setMessage("Request accepted. Waiting for the private Windows runner; an offline queued job may expire after about 24 hours.", "success");
    setBadge("REQUEST QUEUED", "ready");
    progressPanel.hidden = false;
    progressSpinner.hidden = false;
    progressTitle.textContent = "Request is in progress";
    cancelButton.hidden = !cancelToken;
    cancelButton.disabled = false;
    cancelButton.textContent = "Cancel request";
    actionsLink.href = OWNER_ACTIONS_URL;
    addProgress("Request accepted by GitHub Actions.", "pending");
  }

  function setRequestControlsDisabled(disabled) {
    const paused = !SUBMISSIONS_ENABLED;
    input.disabled = paused || disabled || !sessionToken;
    modeSelect.disabled = paused || disabled || !sessionToken;
    languageInput.disabled = paused || disabled || !sessionToken;
    formats.disabled = paused || disabled || !sessionToken;
    submitButton.disabled = paused || disabled || busy || trackingJob || !sessionToken;
    for (const textarea of promptList.querySelectorAll("textarea")) textarea.disabled = disabled || !sessionToken;
  }

  async function loadPromptTemplates() {
    if (!bridgeOrigin || !sessionToken) return;
    const sessionAtRequest = sessionToken;
    try {
      const response = await fetch(`${bridgeOrigin}/api/prompts`, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: { Authorization: `Bearer ${sessionAtRequest}` },
      });
      const result = await response.json().catch(() => ({}));
      if (sessionToken !== sessionAtRequest) return;
      if (!response.ok || result.ok !== true || !result.prompts || typeof result.prompts !== "object") {
        throw new Error("prompt_catalog_unavailable");
      }
      promptTemplates = result.prompts;
      promptList.replaceChildren();
      for (const [name, template] of Object.entries(promptTemplates)) {
        if (typeof template !== "string") continue;
        const details = document.createElement("details");
        details.className = "prompt-item";
        const summary = document.createElement("summary");
        summary.textContent = `${name.replaceAll("_", " ")} prompt`;
        const label = document.createElement("label");
        const textarea = document.createElement("textarea");
        textarea.dataset.preset = name;
        textarea.dataset.original = template;
        textarea.rows = 9;
        textarea.value = template;
        textarea.disabled = !sessionToken;
        label.append(document.createTextNode("Edit for this request"), textarea);
        details.append(summary, label);
        promptList.append(details);
      }
      promptEditor.hidden = false;
    } catch {
      if (sessionToken !== sessionAtRequest) return;
      promptTemplates = {};
      promptEditor.hidden = true;
      setMessage("Signed in. Prompt previews are temporarily unavailable; the default prompt templates will be used.", "error");
    }
  }

  function switchView(viewName) {
    const showLibrary = viewName === "library" && !libraryTab.disabled;
    requestView.hidden = showLibrary;
    libraryView.hidden = !showLibrary;
    requestTab.classList.toggle("active", !showLibrary);
    libraryTab.classList.toggle("active", showLibrary);
    requestTab.setAttribute("aria-selected", String(!showLibrary));
    libraryTab.setAttribute("aria-selected", String(showLibrary));
    requestTab.tabIndex = showLibrary ? -1 : 0;
    libraryTab.tabIndex = showLibrary ? 0 : -1;
  }

  function clearLibrary() {
    libraryRows.length = 0;
    libraryKeywords = [];
    activeKeywordFilters.clear();
    libraryNextOffset = null;
    libraryTotal = 0;
    libraryLoaded = false;
    activeLibraryItem = null;
    libraryStatus.textContent = "Sign in to load your private archive.";
    librarySearch.value = "";
    librarySearch.disabled = true;
    libraryKeywordsElement.replaceChildren();
    libraryCount.textContent = "";
    libraryList.replaceChildren();
    loadMoreLibrary.hidden = true;
    libraryDetail.hidden = true;
    libraryDetailTitle.textContent = "";
    librarySummary.textContent = "";
  }

  async function libraryRequest(path, token, options = {}) {
    const response = await fetch(`${bridgeOrigin}${path}`, {
      method: options.method || "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      clearSession("Your sign-in expired. Sign in again to open your private archive.");
      throw new Error("unauthorized");
    }
    if (!response.ok || result.ok !== true) throw new Error(result.error || "library_unavailable");
    return result;
  }

  async function loadLibrary(reset = false) {
    if (!ensureSession()) return;
    const token = sessionToken;
    if (reset) {
      libraryRows.length = 0;
      activeKeywordFilters.clear();
      libraryNextOffset = null;
      libraryTotal = 0;
      libraryLoaded = false;
      libraryList.replaceChildren();
      libraryDetail.hidden = true;
    }
    libraryStatus.textContent = "Loading your private summaries…";
    librarySearch.disabled = false;
    refreshLibrary.disabled = true;
    loadMoreLibrary.disabled = true;
    try {
      const offset = reset ? 0 : (libraryNextOffset ?? 0);
      const [page, vocabulary] = await Promise.all([
        libraryRequest(`/api/library?limit=50&offset=${offset}`, token),
        reset ? libraryRequest("/api/library/keywords", token) : Promise.resolve({ keywords: libraryKeywords }),
      ]);
      if (sessionToken !== token) return;
      libraryRows.push(...page.items);
      libraryTotal = page.total;
      libraryNextOffset = page.next_offset;
      libraryKeywords = vocabulary.keywords;
      libraryLoaded = true;
      libraryStatus.textContent = libraryTotal
        ? `${libraryTotal} saved video${libraryTotal === 1 ? "" : "s"} in your private knowledge bank.`
        : "No summaries saved yet. New successful requests will appear here.";
      delete libraryStatus.dataset.state;
      librarySearch.disabled = false;
      renderLibraryKeywords();
      renderLibrary();
      loadMoreLibrary.hidden = libraryNextOffset === null;
    } catch (error) {
      if (sessionToken === token && error.message !== "unauthorized") {
        libraryStatus.textContent = "Your private library is temporarily unavailable. Try Refresh in a moment.";
        libraryStatus.dataset.state = "error";
      }
    } finally {
      refreshLibrary.disabled = false;
      loadMoreLibrary.disabled = false;
    }
  }

  function makeKeywordButton(keyword, selected = activeKeywordFilters.has(keyword)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "keyword-filter";
    button.textContent = keyword;
    button.setAttribute("aria-pressed", String(selected));
    button.addEventListener("click", () => {
      if (activeKeywordFilters.has(keyword)) activeKeywordFilters.delete(keyword);
      else activeKeywordFilters.add(keyword);
      renderLibraryKeywords();
      renderLibrary();
    });
    return button;
  }

  function renderLibraryKeywords() {
    libraryKeywordsElement.replaceChildren(...libraryKeywords.map((keyword) => makeKeywordButton(keyword)));
  }

  function renderLibrary() {
    const query = librarySearch.value.trim().toLocaleLowerCase();
    const filtered = libraryRows.filter((item) => {
      const searchable = `${item.title} ${(item.keywords || []).join(" ")}`.toLocaleLowerCase();
      return (!query || searchable.includes(query)) &&
        [...activeKeywordFilters].every((keyword) => (item.keywords || []).includes(keyword));
    });
    libraryCount.textContent = `Showing ${filtered.length} of ${libraryRows.length} loaded (${libraryTotal} total).`;
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = libraryRows.length ? "No saved videos match these filters." : "No summaries to show yet.";
      libraryList.replaceChildren(empty);
      return;
    }
    libraryList.replaceChildren(...filtered.map((item) => {
      const card = document.createElement("article");
      card.className = "library-item";
      const heading = document.createElement("div");
      heading.className = "library-item-heading";
      const title = document.createElement("h2");
      title.textContent = item.title;
      const date = document.createElement("time");
      date.className = "library-item-date";
      date.dateTime = item.summarized_at;
      date.textContent = new Date(item.summarized_at).toLocaleDateString();
      heading.append(title, date);
      const tags = document.createElement("div");
      tags.className = "keyword-filters";
      for (const keyword of item.keywords || []) tags.append(makeKeywordButton(keyword));
      const open = document.createElement("button");
      open.type = "button";
      open.className = "open-summary secondary-button";
      open.textContent = "Open summary";
      open.addEventListener("click", () => void loadLibraryVideo(item.video_id));
      card.append(heading, tags, open);
      return card;
    }));
  }

  async function loadLibraryVideo(videoId) {
    if (!ensureSession()) return;
    const token = sessionToken;
    libraryStatus.textContent = "Loading summary…";
    try {
      const result = await libraryRequest(`/api/library/video/${encodeURIComponent(videoId)}`, token);
      if (sessionToken !== token) return;
      activeLibraryItem = result.item;
      libraryDetailTitle.textContent = result.item.title;
      libraryVideoLink.href = result.item.url;
      libraryDetailKeywords.replaceChildren(...result.item.keywords.map((keyword) => makeKeywordButton(keyword)));
      const formatsAvailable = Object.keys(result.item.summaries);
      libraryFormat.replaceChildren(...formatsAvailable.map((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name.replaceAll("_", " ");
        return option;
      }));
      libraryDetail.hidden = false;
      renderLibrarySummary();
      libraryStatus.textContent = "Summary loaded from your private archive.";
      libraryDetail.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      if (error.message !== "unauthorized") libraryStatus.textContent = "Could not load that saved summary. Please try again.";
    }
  }

  function renderLibrarySummary() {
    if (!activeLibraryItem) return;
    librarySummary.textContent = activeLibraryItem.summaries[libraryFormat.value] || "No summary is available in this format.";
  }

  function addProgress(message, state = "pending") {
    const key = `${state}:${message}`;
    if (seenProgress.has(key)) return;
    seenProgress.add(key);
    const item = document.createElement("li");
    item.dataset.state = state;
    item.textContent = message;
    progressFeed.append(item);
  }

  function finishTracking(state, message) {
    trackingJob = false;
    cancellationRequested = false;
    cancelToken = null;
    activeStatusToken = null;
    activeRequestId = null;
    progressSpinner.hidden = true;
    cancelButton.hidden = true;
    cancelButton.disabled = false;
    cancelButton.textContent = "Cancel request";
    progressTitle.textContent = state === "complete" ? "Request complete" : state === "cancelled" ? "Request cancelled" : "Request needs attention";
    const isSuccessful = state === "complete" || state === "cancelled";
    setBadge(state === "complete" ? "COMPLETE" : state === "cancelled" ? "CANCELLED" : "FAILED", isSuccessful ? "ready" : "error");
    addProgress(message, state);
    setMessage(message, isSuccessful ? "success" : "error");
    if (sessionToken && Date.now() < sessionExpiresAt) setRequestControlsDisabled(false);
  }

  async function pollStatus(requestId, readToken) {
    if (activeRequestId !== requestId) return;
    try {
      const response = await fetch(`${bridgeOrigin}/api/status/${encodeURIComponent(requestId)}`, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: { Authorization: `Bearer ${readToken}` },
      });
      if (response.status === 401) {
        finishTracking("failed", "The private status window expired. Check private Actions for the final result.");
        return;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true || result.request_id !== requestId) throw new Error("status_unavailable");
      for (const event of Array.isArray(result.events) ? result.events : []) {
        if (event && typeof event.message === "string") addProgress(event.message, event.state || "pending");
      }
      if (["complete", "failed", "cancelled"].includes(result.state)) {
        finishTracking(result.state, result.message || (result.state === "complete" ? "Processing completed." : result.state === "cancelled" ? "The request was cancelled." : "Processing failed."));
        return;
      }
      setBadge(result.state === "running" ? "PROCESSING" : "REQUEST QUEUED", "ready");
      if (cancellationRequested) {
        progressTitle.textContent = "Cancelling request";
        setBadge("CANCELLING", "ready");
        setMessage("Cancellation requested. Waiting for GitHub Actions to stop the workflow…", "success");
      } else {
        setMessage(result.message || "Waiting for a status update…", "success");
      }
      progressSpinner.hidden = false;
    } catch {
      setMessage("Status check temporarily unavailable; retrying automatically…", "error");
    }
    if (activeRequestId === requestId) pollTimer = window.setTimeout(() => pollStatus(requestId, readToken), 10_000);
  }

  async function cancelRequest() {
    if (!trackingJob || !activeRequestId || !cancelToken || cancelButton.disabled) return;
    cancelButton.disabled = true;
    cancelButton.textContent = "Cancelling…";
    try {
      const response = await fetch(`${bridgeOrigin}/api/cancel/${encodeURIComponent(activeRequestId)}`, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Authorization": `Bearer ${cancelToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.ok === true && ["cancelling", "cancelled"].includes(result.state)) {
        cancellationRequested = true;
        cancelButton.textContent = "Cancelling…";
        addProgress("Cancellation requested; waiting for GitHub Actions to stop the run.", "pending");
        progressTitle.textContent = "Cancelling request";
        setMessage("Cancellation requested. Waiting for GitHub Actions to stop the workflow…", "success");
        return;
      }
      if (response.ok && result.ok === true && result.state === "already_finished") {
        await pollStatus(activeRequestId, activeStatusToken);
        return;
      }
      cancelButton.disabled = false;
      cancelButton.textContent = "Cancel request";
      if (result.error === "request_not_found_yet") {
        setMessage("GitHub is still registering the workflow. Wait a few seconds, then try cancelling again.", "error");
      } else {
        setMessage("The request could not be cancelled. Check private Actions status and try again if it is still running.", "error");
      }
    } catch {
      cancelButton.disabled = false;
      cancelButton.textContent = "Cancel request";
      setMessage("The cancellation could not be confirmed. Check private Actions status before retrying.", "error");
    }
  }

  function submissionOptions() {
    const outputLanguage = languageInput.value.trim();
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(outputLanguage) ||
        !AUDIO_LANGUAGES.has(outputLanguage.split("-")[0].toLowerCase())) {
      throw new Error("Enter a valid language code supported by MP3 narration; see the language list below the field.");
    }
    const selectedFormats = Array.from(formats.querySelectorAll('input[name="format"]:checked')).map((item) => item.value);
    if (!selectedFormats.includes("concise")) throw new Error("Keep Concise selected because MP3 narration uses that format.");
    const promptOverrides = {};
    for (const textarea of promptList.querySelectorAll("textarea[data-preset]")) {
      const name = textarea.dataset.preset;
      const applicable = selectedFormats.includes(name) || (name.startsWith("system:") && modeSelect.value !== "single");
      if (applicable && textarea.value !== textarea.dataset.original) {
        promptOverrides[name] = textarea.value;
      }
    }
    return { mode: modeSelect.value, output_language: outputLanguage, formats: selectedFormats, prompt_overrides: promptOverrides };
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
    if (!SUBMISSIONS_ENABLED) {
      setMessage("Submissions are paused until the private processing and email flow is verified.", "error");
      return;
    }
    if (!ensureSession() || busy) return;

    let youtubeUrl;
    let options;
    try {
      youtubeUrl = normalizeVideoUrl(input.value.trim());
      options = submissionOptions();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enter a valid YouTube video URL.", "error");
      input.focus();
      return;
    }

    busy = true;
    activeStatusToken = null;
    cancelToken = null;
    cancellationRequested = false;
    submitButton.disabled = true;
    signInButton.disabled = true;
    progressPanel.hidden = false;
    progressSpinner.hidden = false;
    progressTitle.textContent = "Submitting request";
    setRequestControlsDisabled(true);
    setMessage("Sending a private workflow request…");
    try {
      const requestId = crypto.randomUUID().replaceAll("-", "").toLowerCase();
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
        body: JSON.stringify({ youtube_url: youtubeUrl, request_id: requestId, ...options }),
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
        if (typeof result.status_token !== "string" || result.status_token.length > 4096) {
          setMessage("The request was accepted, but a secure live status token was not returned. Check private Actions status before retrying.", "error");
          setBadge("REQUEST ACCEPTED", "ready");
          return;
        }
        activeStatusToken = result.status_token;
        cancelToken = typeof result.cancel_token === "string" && result.cancel_token.length <= 4096
          ? result.cancel_token
          : null;
        activeRequestId = requestId;
        trackingJob = true;
        progressFeed.replaceChildren();
        seenProgress.clear();
        showAccepted();
        if (!cancelToken) setMessage("Request accepted, but cancellation is unavailable for this request. Check private Actions status.", "error");
        void pollStatus(requestId, activeStatusToken);
      }
    } catch {
      setMessage("The bridge could not confirm whether the request was accepted. Check private Actions before retrying.", "error");
      progressSpinner.hidden = true;
      progressPanel.hidden = true;
    } finally {
      busy = false;
      signInButton.disabled = false;
      if (!trackingJob) setRequestControlsDisabled(!ensureSession());
      else submitButton.disabled = true;
      if (!trackingJob) {
        progressSpinner.hidden = true;
        progressPanel.hidden = true;
      }
    }
  }

  signInButton.addEventListener("click", startSignIn);
  signOutButton.addEventListener("click", () => {
    clearSession("Signed out. Sign in again to submit another request.");
    for (const textarea of promptList.querySelectorAll("textarea")) textarea.disabled = true;
  });
  requestTab.addEventListener("click", () => switchView("request"));
  libraryTab.addEventListener("click", () => {
    if (!ensureSession()) return;
    switchView("library");
    if (!libraryLoaded) void loadLibrary(true);
  });
  refreshLibrary.addEventListener("click", () => void loadLibrary(true));
  loadMoreLibrary.addEventListener("click", () => void loadLibrary(false));
  librarySearch.addEventListener("input", renderLibrary);
  libraryFormat.addEventListener("change", renderLibrarySummary);
  form.addEventListener("submit", submitRequest);
  cancelButton.addEventListener("click", cancelRequest);

  if (!bridgeOrigin) {
    signInButton.disabled = true;
    input.disabled = true;
    languageInput.disabled = true;
    submitButton.disabled = true;
    setBadge("SUBMISSIONS PAUSED");
    setMessage("Sign-in is available for verification. Submissions are paused until the private processing and email flow passes an end-to-end check.");
  } else {
    signInButton.disabled = false;
    if (!consumeAuthHandoff()) clearSession();
  }
})();
