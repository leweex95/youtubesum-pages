const encoder = new TextEncoder();
const GITHUB_API = "https://api.github.com";
const OWNER_ACTIONS_URL = "https://github.com/leweex95/youtubesum/actions/workflows/summarize.yml";
const SESSION_SECONDS = 10 * 60;
const MAX_BODY_BYTES = 4096;

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

  if (url.pathname === "/api/dispatch" && request.method === "POST") {
    return dispatchWorkflow(request, env);
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

  const installationToken = await createInstallationToken(env);
  const repo = `${env.REPOSITORY_OWNER}/${env.REPOSITORY_NAME}`;
  const dispatchResponse = await fetch(`${GITHUB_API}/repos/${repo}/actions/workflows/${encodeURIComponent(env.WORKFLOW_FILE)}/dispatches`, {
    method: "POST",
    headers: githubHeaders(installationToken),
    body: JSON.stringify({
      ref: env.WORKFLOW_REF,
      inputs: { youtube_url: youtubeUrl },
    }),
  });
  if (dispatchResponse.status !== 204) {
    return jsonResponse({ ok: false, error: "workflow_dispatch_failed" }, 502, request, env);
  }

  return jsonResponse({ ok: true, actions_url: OWNER_ACTIONS_URL }, 202, request, env);
}

async function createInstallationToken(env) {
  const appJwt = await createGitHubAppJwt(env);
  const response = await fetch(`${GITHUB_API}/app/installations/${encodeURIComponent(env.GITHUB_APP_INSTALLATION_ID)}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(appJwt),
    body: JSON.stringify({
      repositories: [env.REPOSITORY_NAME],
      permissions: { actions: "write" },
    }),
  });
  if (!response.ok) throw new Error("installation_token_failed");
  const result = await response.json().catch(() => ({}));
  if (typeof result.token !== "string" || !result.token) throw new Error("installation_token_failed");
  return result.token;
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
  if (origin !== env.PAGES_ORIGIN || requestedMethod !== "POST" || requestedHeaders.some((header) => !allowedHeaders.has(header))) {
    return jsonResponse({ ok: false, error: "origin_not_allowed" }, 403, request, env);
  }
  return new Response(null, {
    status: 204,
    headers: securityHeaders({
      ...corsHeaders(origin),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
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
