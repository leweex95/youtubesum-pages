const encoder = new TextEncoder();
const GITHUB_API = "https://api.github.com";
const OWNER_ACTIONS_URL = "https://github.com/leweex95/youtubesum/actions/workflows/summarize.yml";
const SESSION_SECONDS = 10 * 60;
const MAX_BODY_BYTES = 24 * 1024;
const PROMPT_FILES = Object.freeze({
  concise: "prompts/concise.md",
  detailed: "prompts/detailed.md",
  key_takeaways: "prompts/key_takeaways.md",
  critical: "prompts/critical_analysis.md",
  "system:chunk_summary.md": "prompts/chunk_summary.md",
  "system:chunk_reduction.md": "prompts/chunk_reduction.md",
  "system:final_synthesis.md": "prompts/final_synthesis.md",
});
const PROGRESS_STATES = Object.freeze({
  runner_started: ["pending", "Windows runner started"],
  processing: ["pending", "Processing video"],
  summary_ready: ["pending", "Summary generated"],
  audio_ready: ["pending", "MP3 narration generated"],
  email_sending: ["pending", "Sending email"],
  email_sent: ["pending", "Email sent (SMTP accepted)"],
  email_failed: ["failure", "Email delivery failed"],
  failed: ["failure", "Processing failed"],
});

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch {
      // Never return upstream response bodies, OAuth tokens, or signing details.
      return jsonResponse({ ok: false, error: "bridge_unavailable" }, 503, request, env);
    }
  },
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse({ ok: true }, 200, request, env);
  }

  if (url.pathname === "/auth/start" && request.method === "GET") {
    return startOAuth(request, env);
  }

  if (url.pathname === "/auth/callback" && request.method === "GET") {
    return finishOAuth(request, env);
  }

  if (url.pathname === "/api/dispatch" && request.method === "OPTIONS") {
    return preflight(request, env);
  }

  if ((url.pathname === "/api/prompts" || url.pathname === "/api/status" || url.pathname.startsWith("/api/status/")) && request.method === "OPTIONS") {
    return preflight(request, env);
  }

  if (url.pathname.startsWith("/api/cancel/") && request.method === "OPTIONS") {
    return preflight(request, env);
  }

  if (url.pathname === "/api/prompts" && request.method === "GET") {
    return getPrompts(request, env);
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    return getStatus(request, env);
  }

  if (url.pathname.startsWith("/api/status/") && request.method === "GET") {
    return getStatus(request, env, url.pathname.slice("/api/status/".length));
  }

  if (url.pathname === "/api/dispatch" && request.method === "POST") {
    return dispatchWorkflow(request, env);
  }

  if (url.pathname.startsWith("/api/cancel/") && request.method === "POST") {
    return cancelWorkflow(request, env, url.pathname.slice("/api/cancel/".length));
  }

  if (url.pathname === "/api/progress" && request.method === "POST") {
    return receiveProgress(request, env);
  }

  return jsonResponse({ ok: false, error: "not_found" }, 404, request, env);
}

export function canonicalizeYouTubeUrl(input) {
  if (typeof input !== "string" || input.length > 2048 || /[\u0000-\u0020\u007f]/.test(input)) {
    throw new Error("invalid_url");
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid_url");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const videoHosts = new Set([
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be", "www.youtu.be",
  ]);
  if (!videoHosts.has(host) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("unsupported_url");
  }
  if (url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))) {
    throw new Error("unsupported_url");
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

  if (!videoId) throw new Error("unsupported_url");
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export async function createSessionToken(login, userId, env, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + SESSION_SECONDS;
  const payload = {
    aud: env.PAGES_ORIGIN,
    exp: expiry,
    iat: Math.floor(now / 1000),
    login: login.toLowerCase(),
    user_id: String(userId),
  };
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await signHmac(encodedPayload, env.SESSION_SIGNING_SECRET);
  return { token: `${encodedPayload}.${encodeBase64Url(signature)}`, expiresAt: expiry * 1000 };
}

async function startOAuth(request, env) {
  if (!isConfiguredValue(env.GITHUB_APP_CLIENT_ID) || !isConfiguredValue(env.PAGES_ORIGIN)) {
    return popupResponse({ ok: false, code: "bridge_not_configured" }, env);
  }
  const requestUrl = new URL(request.url);
  if (!requestUrl.hostname.endsWith(".workers.dev")) {
    return popupResponse({ ok: false, code: "bridge_origin_invalid" }, env);
  }

  const state = encodeBase64Url(randomBytes(32));
  const callback = new URL("/auth/callback", requestUrl.origin).href;
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: securityHeaders({
      Location: authorize.href,
      "Set-Cookie": `oauth_state=${state}; Path=/auth/callback; Max-Age=300; Secure; HttpOnly; SameSite=Lax`,
      "Cache-Control": "no-store",
    }),
  });
}

async function finishOAuth(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const cookieState = getCookie(request, "oauth_state");
  const clearStateCookie = "oauth_state=; Path=/auth/callback; Max-Age=0; Secure; HttpOnly; SameSite=Lax";

  if (!url.hostname.endsWith(".workers.dev") || !state || !cookieState || !constantTimeEqual(state, cookieState)) {
    return popupResponse({ ok: false, code: "sign_in_failed" }, env, clearStateCookie);
  }
  if (url.searchParams.has("error")) {
    return popupResponse({ ok: false, code: "sign_in_cancelled" }, env, clearStateCookie);
  }
  const code = url.searchParams.get("code");
  if (!code || !isConfiguredValue(env.GITHUB_APP_CLIENT_ID) || !isConfiguredValue(env.GITHUB_APP_CLIENT_SECRET) ||
      !isConfiguredValue(env.SESSION_SIGNING_SECRET)) {
    return popupResponse({ ok: false, code: "bridge_not_configured" }, env, clearStateCookie);
  }

  const callback = new URL("/auth/callback", url.origin).href;
  const oauthResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      redirect_uri: callback,
      state,
    }),
  });
  if (!oauthResponse.ok) return popupResponse({ ok: false, code: "sign_in_failed" }, env, clearStateCookie);
  const oauth = await oauthResponse.json().catch(() => ({}));
  if (typeof oauth.access_token !== "string" || !oauth.access_token) {
    return popupResponse({ ok: false, code: "sign_in_failed" }, env, clearStateCookie);
  }

  const userResponse = await fetch(`${GITHUB_API}/user`, {
    headers: githubHeaders(oauth.access_token),
  });
  if (!userResponse.ok) return popupResponse({ ok: false, code: "sign_in_failed" }, env, clearStateCookie);
  const user = await userResponse.json().catch(() => ({}));
  if (String(user.id) !== String(env.ALLOWED_GITHUB_USER_ID) ||
      String(user.login).toLowerCase() !== String(env.ALLOWED_GITHUB_LOGIN).toLowerCase()) {
    return popupResponse({ ok: false, code: "account_not_allowed" }, env, clearStateCookie);
  }

  const session = await createSessionToken(user.login, user.id, env);
  return popupResponse({ ok: true, token: session.token, expiresAt: session.expiresAt }, env, clearStateCookie);
}

async function dispatchWorkflow(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (origin !== env.PAGES_ORIGIN) return jsonResponse({ ok: false, error: "origin_not_allowed" }, 403, request, env);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 415, request, env);
  }

  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(authorization);
  if (!match || !(await verifySessionToken(match[1], env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401, request, env);
  }
  if (!configuredForDispatch(env)) return jsonResponse({ ok: false, error: "bridge_not_configured" }, 503, request, env);

  let body;
  try {
    body = await readJsonLimited(request);
  } catch {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400, request, env);
  }
  let youtubeUrl;
  try {
    youtubeUrl = canonicalizeYouTubeUrl(body.youtube_url);
  } catch {
    return jsonResponse({ ok: false, error: "invalid_youtube_url" }, 400, request, env);
  }

  const requestId = body.request_id;
  if (typeof requestId !== "string" || !/^[a-f0-9]{32}$/.test(requestId)) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400, request, env);
  }
  const mode = body.mode ?? "auto";
  if (!["auto", "single", "chunked"].includes(mode)) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400, request, env);
  }
  const formats = body.formats ?? ["concise"];
  if (!Array.isArray(formats) || !formats.length || formats.length > 4 ||
      formats.some((name) => typeof name !== "string" || name.startsWith("system:") || !Object.hasOwn(PROMPT_FILES, name)) ||
      new Set(formats).size !== formats.length || !formats.includes("concise")) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400, request, env);
  }
  const promptOverrides = body.prompt_overrides ?? {};
  if (!promptOverrides || typeof promptOverrides !== "object" || Array.isArray(promptOverrides) ||
      Object.keys(promptOverrides).length > 7 ||
      Object.entries(promptOverrides).some(([name, value]) =>
        (!formats.includes(name) && !(name.startsWith("system:") && mode !== "single" && Object.hasOwn(PROMPT_FILES, name))) ||
        typeof value !== "string" || !isValidPromptTemplate(value)) ||
      JSON.stringify(promptOverrides).length > 20_000) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400, request, env);
  }

  const installationToken = await createInstallationToken(env);
  const progressToken = await createProgressToken(requestId, env);
  const cancelToken = await createRequestCancelToken(requestId, env);
  const repo = `${env.REPOSITORY_OWNER}/${env.REPOSITORY_NAME}`;
  const dispatchResponse = await fetch(`${GITHUB_API}/repos/${repo}/actions/workflows/${encodeURIComponent(env.WORKFLOW_FILE)}/dispatches`, {
    method: "POST",
    headers: githubHeaders(installationToken),
    body: JSON.stringify({
      ref: env.WORKFLOW_REF,
      inputs: {
        youtube_url: youtubeUrl,
        request_id: requestId,
        status_token: progressToken,
        summary_mode: mode,
        summary_formats: formats.join(","),
        prompt_overrides: JSON.stringify(promptOverrides),
      },
    }),
  });
  if (dispatchResponse.status !== 204) {
    return jsonResponse({ ok: false, error: "workflow_dispatch_failed" }, 502, request, env);
  }

  const statusReadToken = await createStatusReadToken(requestId, env);
  return jsonResponse({
    ok: true,
    request_id: requestId,
    status_token: statusReadToken,
    cancel_token: cancelToken,
    actions_url: OWNER_ACTIONS_URL,
  }, 202, request, env);
}

async function cancelWorkflow(request, env, requestId) {
  if (!isAllowedPagesOrigin(request, env)) {
    return jsonResponse({ ok: false, error: "origin_not_allowed" }, 403, request, env);
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 415, request, env);
  }
  if (!/^[a-f0-9]{32}$/.test(requestId)) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400, request, env);
  }

  const bearer = /^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(request.headers.get("Authorization") || "");
  if (!bearer || !(await verifyRequestCancelToken(bearer[1], requestId, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401, request, env);
  }
  if (!configuredForDispatch(env)) {
    return jsonResponse({ ok: false, error: "bridge_not_configured" }, 503, request, env);
  }

  const token = await createInstallationToken(env, { actions: "write" });
  const run = await findRun(requestId, token, env);
  if (!run) {
    return jsonResponse({ ok: false, error: "request_not_found_yet" }, 409, request, env);
  }
  if (run.status === "completed") {
    return jsonResponse({ ok: true, state: run.conclusion === "cancelled" ? "cancelled" : "already_finished" }, 200, request, env);
  }

  const repo = `${env.REPOSITORY_OWNER}/${env.REPOSITORY_NAME}`;
  const cancelResponse = await fetch(`${GITHUB_API}/repos/${repo}/actions/runs/${encodeURIComponent(run.id)}/cancel`, {
    method: "POST",
    headers: githubHeaders(token),
  });
  if (cancelResponse.status === 202) {
    return jsonResponse({ ok: true, state: "cancelling" }, 202, request, env);
  }

  // A run can finish between the lookup and cancellation request. Report its
  // current terminal state instead of turning that harmless race into an error.
  if (cancelResponse.status === 409 || cancelResponse.status === 422) {
    const latestResponse = await fetch(`${GITHUB_API}/repos/${repo}/actions/runs/${encodeURIComponent(run.id)}`, {
      headers: githubHeaders(token),
    });
    if (latestResponse.ok) {
      const latest = await latestResponse.json().catch(() => ({}));
      if (latest.status === "completed") {
        return jsonResponse({ ok: true, state: latest.conclusion === "cancelled" ? "cancelled" : "already_finished" }, 200, request, env);
      }
    }
  }
  return jsonResponse({ ok: false, error: "workflow_cancel_failed" }, 502, request, env);
}

function isValidPromptTemplate(template) {
  if (!template.trim() || template.length > 6_000) return false;
  const normalized = template.replaceAll("{{", "").replaceAll("}}", "");
  const fields = [...normalized.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]);
  const remainder = normalized.replace(/\{([^{}]*)\}/g, "");
  const allowed = new Set([
    "video_title", "channel", "video_url", "transcript_language",
    "output_language", "transcript", "source_context",
  ]);
  return !/[{}]/.test(remainder) && fields.every((field) => allowed.has(field)) &&
    fields.includes("transcript") && fields.includes("output_language");
}

async function createInstallationToken(env, permissions = { actions: "write" }) {
  const appJwt = await createGitHubAppJwt(env);
  const response = await fetch(`${GITHUB_API}/app/installations/${encodeURIComponent(env.GITHUB_APP_INSTALLATION_ID)}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(appJwt),
    body: JSON.stringify({
      repositories: [env.REPOSITORY_NAME],
      permissions,
    }),
  });
  if (!response.ok) throw new Error("installation_token_failed");
  const result = await response.json().catch(() => ({}));
  if (typeof result.token !== "string" || !result.token) throw new Error("installation_token_failed");
  return result.token;
}

async function getPrompts(request, env) {
  if (!isAllowedPagesOrigin(request, env) || !(await hasOwnerSession(request, env))) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401, request, env);
  }
  const token = await createInstallationToken(env, { contents: "read" });
  const prompts = {};
  for (const [name, path] of Object.entries(PROMPT_FILES)) {
    prompts[name] = await readRepositoryText(path, token, env);
  }
  return jsonResponse({ ok: true, prompts }, 200, request, env);
}

async function readRepositoryText(path, token, env) {
  const repo = `${env.REPOSITORY_OWNER}/${env.REPOSITORY_NAME}`;
  const url = new URL(`${GITHUB_API}/repos/${repo}/contents/${path}`);
  url.searchParams.set("ref", env.WORKFLOW_REF);
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error("prompt_catalog_unavailable");
  const item = await response.json().catch(() => ({}));
  if (item.encoding !== "base64" || typeof item.content !== "string") {
    throw new Error("prompt_catalog_unavailable");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(item.content.replace(/\s/g, "")));
  if (!text.trim() || text.length > 20_000) throw new Error("prompt_catalog_unavailable");
  return text;
}

async function getStatus(request, env, requestId = "") {
  const bearer = /^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(request.headers.get("Authorization") || "");
  const sessionValid = bearer && await verifySessionToken(bearer[1], env);
  const statusValid = bearer && await verifyStatusReadToken(bearer[1], requestId, env);
  if (!isAllowedPagesOrigin(request, env) || !(sessionValid || statusValid)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401, request, env);
  }
  if (!/^[a-f0-9]{32}$/.test(requestId)) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400, request, env);
  }
  const token = await createInstallationToken(env, { actions: "read", statuses: "read" });
  const run = await findRun(requestId, token, env);
  if (!run) {
    return jsonResponse({ ok: true, request_id: requestId, state: "queued", message: "Request accepted; waiting for GitHub Actions." }, 200, request, env);
  }
  const statusUrl = `${GITHUB_API}/repos/${env.REPOSITORY_OWNER}/${env.REPOSITORY_NAME}/commits/${encodeURIComponent(run.head_sha)}/statuses?per_page=100`;
  const response = await fetch(statusUrl, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error("status_unavailable");
  const statuses = await response.json().catch(() => []);
  const latest = Array.isArray(statuses)
    ? statuses.find((item) => item.context === `youtubesum/request/${requestId}`)
    : null;
  const events = Array.isArray(statuses)
    ? statuses.filter((item) => item.context === `youtubesum/request/${requestId}`)
      .reverse()
      .map((item) => ({
        state: item.description === "Email sent (SMTP accepted)" ? "success" : item.state,
        message: safeProgressMessage(item.description, item.state),
        updated_at: item.updated_at,
      }))
    : [];
  let state = "queued";
  let message = "Request accepted; waiting for the Windows runner.";
  if (latest) {
    state = latest.state === "success" ? "complete" : latest.state === "failure" || latest.state === "error" ? "failed" : "running";
    message = safeProgressMessage(latest.description, state);
  } else if (run.status === "in_progress") {
    state = "running";
    message = "The Windows runner is online and processing the request.";
  }
  if (run.status === "completed" && run.conclusion !== "success") {
    if (run.conclusion === "cancelled") {
      state = "cancelled";
      message = "The request was cancelled.";
    } else {
      state = "failed";
      message = "The private workflow failed before completion. Check private Actions for details.";
    }
  } else if (run.status === "completed" && run.conclusion === "success" && state !== "complete") {
    state = "complete";
    message = "Processing completed successfully.";
  }
  return jsonResponse({
    ok: true,
    request_id: requestId,
    state,
    message,
    events,
    actions_url: OWNER_ACTIONS_URL,
    updated_at: latest?.updated_at || run.updated_at || run.created_at,
  }, 200, request, env);
}

async function findRun(requestId, token, env) {
  const repo = `${env.REPOSITORY_OWNER}/${env.REPOSITORY_NAME}`;
  const url = new URL(`${GITHUB_API}/repos/${repo}/actions/workflows/${encodeURIComponent(env.WORKFLOW_FILE)}/runs`);
  url.searchParams.set("event", "workflow_dispatch");
  url.searchParams.set("per_page", "50");
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error("workflow_status_unavailable");
  const result = await response.json().catch(() => ({}));
  const title = `YouTube summary request ${requestId}`;
  return (result.workflow_runs || []).find((run) => run.display_title === title) || null;
}

async function receiveProgress(request, env) {
  let body;
  try {
    body = await readJsonLimited(request);
  } catch {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400, request, env);
  }
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(authorization);
  if (!match || !(await verifyProgressToken(match[1], body.request_id, env)) ||
      !/^[a-f0-9]{32}$/.test(body.request_id || "") || !/^\d+$/.test(String(body.run_id || "")) ||
      !Object.hasOwn(PROGRESS_STATES, body.state)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401, request, env);
  }
  const token = await createInstallationToken(env, { actions: "read", statuses: "write" });
  const repo = `${env.REPOSITORY_OWNER}/${env.REPOSITORY_NAME}`;
  const runResponse = await fetch(`${GITHUB_API}/repos/${repo}/actions/runs/${encodeURIComponent(body.run_id)}`, {
    headers: githubHeaders(token),
  });
  if (!runResponse.ok) return jsonResponse({ ok: false, error: "run_not_found" }, 404, request, env);
  const run = await runResponse.json().catch(() => ({}));
  if (run.display_title !== `YouTube summary request ${body.request_id}` || !/^[a-f0-9]{40}$/.test(run.head_sha || "")) {
    return jsonResponse({ ok: false, error: "run_not_allowed" }, 403, request, env);
  }
  const [state, description] = PROGRESS_STATES[body.state];
  const statusResponse = await fetch(`${GITHUB_API}/repos/${repo}/statuses/${run.head_sha}`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({
      state,
      context: `youtubesum/request/${body.request_id}`,
      description,
      target_url: OWNER_ACTIONS_URL,
    }),
  });
  if (!statusResponse.ok) throw new Error("progress_write_failed");
  return jsonResponse({ ok: true }, 202, request, env);
}

function safeProgressMessage(description, state) {
  const allowed = new Set(Object.values(PROGRESS_STATES).map((item) => item[1]));
  if (allowed.has(description)) return description;
  if (state === "complete") return "Email sent successfully.";
  if (state === "failed") return "The private workflow failed. Check private Actions for details.";
  return "The private runner is processing the request.";
}

function isAllowedPagesOrigin(request, env) {
  return (request.headers.get("Origin") || "") === env.PAGES_ORIGIN;
}

async function hasOwnerSession(request, env) {
  const match = /^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(request.headers.get("Authorization") || "");
  return Boolean(match && await verifySessionToken(match[1], env));
}

async function createProgressToken(requestId, env, now = Date.now()) {
  const encoded = encodeBase64Url(encoder.encode(JSON.stringify({
    exp: Math.floor(now / 1000) + 48 * 60 * 60,
    request_id: requestId,
    scope: "progress",
  })));
  return `${encoded}.${encodeBase64Url(await signHmac(encoded, env.SESSION_SIGNING_SECRET))}`;
}

async function createStatusReadToken(requestId, env, now = Date.now()) {
  const encoded = encodeBase64Url(encoder.encode(JSON.stringify({
    exp: Math.floor(now / 1000) + 48 * 60 * 60,
    request_id: requestId,
    scope: "status:read",
  })));
  return `${encoded}.${encodeBase64Url(await signHmac(encoded, env.SESSION_SIGNING_SECRET))}`;
}

async function createRequestCancelToken(requestId, env, now = Date.now()) {
  const encoded = encodeBase64Url(encoder.encode(JSON.stringify({
    exp: Math.floor(now / 1000) + 48 * 60 * 60,
    request_id: requestId,
    scope: "request:cancel",
  })));
  return `${encoded}.${encodeBase64Url(await signHmac(encoded, env.SESSION_SIGNING_SECRET))}`;
}

async function verifyStatusReadToken(token, requestId, env, now = Date.now()) {
  if (!isConfiguredValue(env.SESSION_SIGNING_SECRET)) return false;
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2) return false;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await crypto.subtle.importKey("raw", encoder.encode(env.SESSION_SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
      decodeBase64Url(parts[1]),
      encoder.encode(parts[0]),
    );
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    return valid && payload.scope === "status:read" && payload.request_id === requestId &&
      Number.isInteger(payload.exp) && payload.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

async function verifyRequestCancelToken(token, requestId, env, now = Date.now()) {
  if (!isConfiguredValue(env.SESSION_SIGNING_SECRET)) return false;
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2) return false;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await crypto.subtle.importKey("raw", encoder.encode(env.SESSION_SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
      decodeBase64Url(parts[1]),
      encoder.encode(parts[0]),
    );
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    return valid && payload.scope === "request:cancel" && payload.request_id === requestId &&
      Number.isInteger(payload.exp) && payload.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

async function verifyProgressToken(token, requestId, env, now = Date.now()) {
  if (!isConfiguredValue(env.SESSION_SIGNING_SECRET)) return false;
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2) return false;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await crypto.subtle.importKey("raw", encoder.encode(env.SESSION_SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
      decodeBase64Url(parts[1]),
      encoder.encode(parts[0]),
    );
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    return valid && payload.scope === "progress" && payload.request_id === requestId && Number.isInteger(payload.exp) && payload.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

async function createGitHubAppJwt(env, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    exp: issuedAt + 9 * 60,
    iat: issuedAt,
    iss: String(env.GITHUB_APP_ID),
  })));
  const message = `${header}.${payload}`;
  const keyBytes = parsePrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(message));
  return `${message}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifySessionToken(token, env, now = Date.now()) {
  if (!env.SESSION_SIGNING_SECRET || new TextEncoder().encode(env.SESSION_SIGNING_SECRET).length < 32) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  let payload;
  let signature;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    signature = decodeBase64Url(parts[1]);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.SESSION_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(parts[0]));
  return valid && payload.aud === env.PAGES_ORIGIN &&
    payload.login === String(env.ALLOWED_GITHUB_LOGIN).toLowerCase() &&
    payload.user_id === String(env.ALLOWED_GITHUB_USER_ID) &&
    Number.isInteger(payload.exp) && payload.exp > Math.floor(now / 1000);
}

function configuredForDispatch(env) {
  return [
    env.GITHUB_APP_ID, env.GITHUB_APP_INSTALLATION_ID, env.GITHUB_APP_PRIVATE_KEY,
    env.SESSION_SIGNING_SECRET, env.PAGES_ORIGIN, env.ALLOWED_GITHUB_LOGIN,
    env.ALLOWED_GITHUB_USER_ID, env.REPOSITORY_OWNER, env.REPOSITORY_NAME,
    env.WORKFLOW_FILE, env.WORKFLOW_REF,
  ].every(isConfiguredValue);
}

function isConfiguredValue(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "CONFIGURE_ME";
}

async function readJsonLimited(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || "0");
  if (declaredLength > MAX_BODY_BYTES) throw new Error("request_too_large");
  if (!request.body) throw new Error("empty_request");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("request_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json");
  return parsed;
}

function preflight(request, env) {
  const origin = request.headers.get("Origin") || "";
  const requestedMethod = request.headers.get("Access-Control-Request-Method") || "";
  const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "")
    .toLowerCase().split(",").map((header) => header.trim()).filter(Boolean);
  const allowedHeaders = new Set(["authorization", "content-type"]);
  if (origin !== env.PAGES_ORIGIN || !["GET", "POST"].includes(requestedMethod) || requestedHeaders.some((header) => !allowedHeaders.has(header))) {
    return jsonResponse({ ok: false, error: "origin_not_allowed" }, 403, request, env);
  }
  return new Response(null, {
    status: 204,
    headers: securityHeaders({
      ...corsHeaders(origin),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
    }),
  });
}

function jsonResponse(value, status, request, env) {
  const origin = request.headers.get("Origin") || "";
  const cors = origin && origin === env.PAGES_ORIGIN ? corsHeaders(origin) : {};
  return new Response(JSON.stringify(value), {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors }),
  });
}

function corsHeaders(origin) {
  return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
}

function securityHeaders(headers = {}) {
  return new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    ...Object.fromEntries(new Headers(headers)),
  });
}

function popupResponse(message, env, clearCookie = "") {
  const pagesOrigin = env.PAGES_ORIGIN || "https://leweex95.github.io";
  const pagesUrl = env.PAGES_URL || `${pagesOrigin}/youtubesum-pages/`;
  const nonce = encodeBase64Url(randomBytes(18));
  const safeMessage = JSON.stringify({ ...message, type: "youtubesum-auth" })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  const safeOrigin = JSON.stringify(pagesOrigin);
  const handoff = message.ok === true
    ? `${pagesUrl}#bridge_session=${encodeURIComponent(message.token)}&expires=${message.expiresAt}`
    : `${pagesUrl}#bridge_error=${encodeURIComponent(message.code || "sign_in_failed")}`;
  const safeHandoff = JSON.stringify(handoff).replaceAll("<", "\\u003c");
  const headers = securityHeaders({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "Cross-Origin-Opener-Policy": "unsafe-none",
  });
  if (clearCookie) headers.append("Set-Cookie", clearCookie);
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Sign-in complete</title></head><body><p>Sign-in complete. You can close this window.</p><script nonce="${nonce}">if (window.opener && !window.opener.closed) { window.opener.postMessage(${safeMessage}, ${safeOrigin}); window.close(); } else { window.location.replace(${safeHandoff}); }</script></body></html>`, { status: 200, headers });
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "youtubesum-pages-bridge",
    "Content-Type": "application/json",
  };
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  for (const pair of cookies.split(";")) {
    const index = pair.indexOf("=");
    if (index >= 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return "";
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function parsePrivateKey(pem) {
  if (typeof pem !== "string") throw new Error("private_key_invalid");
  const match = /-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----([\s\S]+?)-----END \1-----/.exec(pem.trim());
  if (!match) throw new Error("private_key_invalid");
  const bytes = decodeBase64(match[2].replace(/\s/g, ""));
  return match[1] === "PRIVATE KEY" ? bytes : wrapPkcs1AsPkcs8(bytes);
}

function wrapPkcs1AsPkcs8(pkcs1) {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const algorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const privateKey = derValue(0x04, pkcs1);
  return derValue(0x30, concatBytes(version, algorithm, privateKey));
}

function derValue(tag, content) {
  const length = derLength(content.length);
  return concatBytes(Uint8Array.of(tag), length, content);
}

function derLength(length) {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...arrays) {
  const output = new Uint8Array(arrays.reduce((size, array) => size + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }
  return output;
}

async function signHmac(message, secret) {
  if (typeof secret !== "string" || encoder.encode(secret).length < 32) throw new Error("session_secret_invalid");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return decodeBase64(base64 + "=".repeat((4 - base64.length % 4) % 4));
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
