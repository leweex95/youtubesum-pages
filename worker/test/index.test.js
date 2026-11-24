import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateKey, webcrypto } from "node:crypto";
import { canonicalizeYouTubeUrl, createSessionToken, handleRequest } from "../src/index.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const baseEnv = {
  PAGES_ORIGIN: "https://leweex95.github.io",
  ALLOWED_GITHUB_LOGIN: "leweex95",
  ALLOWED_GITHUB_USER_ID: "74991597",
  REPOSITORY_OWNER: "leweex95",
  REPOSITORY_NAME: "youtubesum",
  WORKFLOW_FILE: "summarize.yml",
  WORKFLOW_REF: "main",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_INSTALLATION_ID: "67890",
  SESSION_SIGNING_SECRET: "test-session-signing-secret-32-bytes-minimum",
};

test("canonicalizes supported one-video URLs and strips query parameters", () => {
  assert.equal(
    canonicalizeYouTubeUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw&feature=share"),
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  );
  assert.equal(
    canonicalizeYouTubeUrl("https://youtu.be/jNQXAC9IVRw?si=tracking-value"),
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  );
  assert.equal(
    canonicalizeYouTubeUrl("https://youtube.com/shorts/jNQXAC9IVRw"),
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  );
});

test("rejects non-YouTube hosts, playlists, malformed IDs, and credential-bearing URLs", () => {
  for (const value of [
    "https://youtube.com.evil.example/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PL123",
    "https://www.youtube.com/watch?v=short",
    "https://user:password@youtu.be/jNQXAC9IVRw",
    "file:///C:/private.txt",
  ]) {
    assert.throws(() => canonicalizeYouTubeUrl(value));
  }
});

test("health is public but returns no configuration details", async () => {
  const response = await handleRequest(new Request("https://bridge.workers.dev/health"), baseEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("private prompt catalogue and request status require an approved origin and bearer token", async () => {
  const prompts = await handleRequest(new Request("https://bridge.workers.dev/api/prompts", {
    headers: { Origin: baseEnv.PAGES_ORIGIN },
  }), baseEnv);
  assert.equal(prompts.status, 401);

  const status = await handleRequest(new Request(
    "https://bridge.workers.dev/api/status/0123456789abcdef0123456789abcdef",
    { headers: { Origin: baseEnv.PAGES_ORIGIN } },
  ), baseEnv);
  assert.equal(status.status, 401);

  const wrongOrigin = await handleRequest(new Request("https://bridge.workers.dev/api/prompts", {
    headers: { Origin: "https://attacker.example", Authorization: "Bearer invalid" },
  }), baseEnv);
  assert.equal(wrongOrigin.status, 401);
});

test("CORS preflight permits only the Pages origin and dispatch headers", async () => {
  const approved = await handleRequest(new Request("https://bridge.workers.dev/api/dispatch", {
    method: "OPTIONS",
    headers: {
      Origin: baseEnv.PAGES_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  }), baseEnv);
  assert.equal(approved.status, 204);
  assert.equal(approved.headers.get("Access-Control-Allow-Origin"), baseEnv.PAGES_ORIGIN);
  assert.equal(approved.headers.get("Access-Control-Allow-Credentials"), null);

  const statusOptions = await handleRequest(new Request("https://bridge.workers.dev/api/status/0123456789abcdef0123456789abcdef", {
    method: "OPTIONS",
    headers: {
      Origin: baseEnv.PAGES_ORIGIN,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
    },
  }), baseEnv);
  assert.equal(statusOptions.status, 204);

  const cancelOptions = await handleRequest(new Request("https://bridge.workers.dev/api/cancel/0123456789abcdef0123456789abcdef", {
    method: "OPTIONS",
    headers: {
      Origin: baseEnv.PAGES_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  }), baseEnv);
  assert.equal(cancelOptions.status, 204);

  const denied = await handleRequest(new Request("https://bridge.workers.dev/api/dispatch", {
    method: "OPTIONS",
    headers: {
      Origin: "https://attacker.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  }), baseEnv);
  assert.equal(denied.status, 403);
});

test("OAuth start uses a random state cookie and the Worker's fixed callback", async () => {
  const env = { ...baseEnv, GITHUB_APP_CLIENT_ID: "public-client-id" };
  const response = await handleRequest(new Request("https://bridge.workers.dev/auth/start"), env);
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("Location"));
  assert.equal(location.origin, "https://github.com");
  assert.equal(location.pathname, "/login/oauth/authorize");
  assert.equal(location.searchParams.get("client_id"), "public-client-id");
  assert.equal(location.searchParams.get("redirect_uri"), "https://bridge.workers.dev/auth/callback");
  assert.ok(location.searchParams.get("state"));
  assert.match(response.headers.get("Set-Cookie"), /Secure; HttpOnly; SameSite=Lax/);
});

test("OAuth callback accepts only the configured owner and returns no GitHub access token", async () => {
  const env = {
    ...baseEnv,
    GITHUB_APP_CLIENT_ID: "public-client-id",
    GITHUB_APP_CLIENT_SECRET: "test-oauth-client-secret",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input) === "https://github.com/login/oauth/access_token") {
      assert.equal(JSON.parse(init.body).client_secret, env.GITHUB_APP_CLIENT_SECRET);
      return Response.json({ access_token: "temporary-github-user-token" });
    }
    if (String(input) === "https://api.github.com/user") {
      assert.equal(init.headers.Authorization, "Bearer temporary-github-user-token");
      return Response.json({ id: 74991597, login: "leweex95" });
    }
    throw new Error("unexpected upstream request");
  };

  try {
    const start = await handleRequest(new Request("https://bridge.workers.dev/auth/start"), env);
    const state = new URL(start.headers.get("Location")).searchParams.get("state");
    const stateCookie = start.headers.get("Set-Cookie").split(";")[0];
    const callback = await handleRequest(new Request(
      `https://bridge.workers.dev/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: stateCookie } },
    ), env);
    const html = await callback.text();
    assert.equal(callback.status, 200);
    assert.match(html, /youtubesum-auth/);
    assert.match(html, /"ok":true/);
    assert.doesNotMatch(html, /temporary-github-user-token/);
    assert.match(callback.headers.get("Set-Cookie"), /Max-Age=0/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth callback rejects a different GitHub account", async () => {
  const env = {
    ...baseEnv,
    GITHUB_APP_CLIENT_ID: "public-client-id",
    GITHUB_APP_CLIENT_SECRET: "test-oauth-client-secret",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input) === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "temporary-github-user-token" });
    }
    if (String(input) === "https://api.github.com/user") {
      return Response.json({ id: 123, login: "not-the-owner" });
    }
    throw new Error("unexpected upstream request");
  };

  try {
    const start = await handleRequest(new Request("https://bridge.workers.dev/auth/start"), env);
    const state = new URL(start.headers.get("Location")).searchParams.get("state");
    const callback = await handleRequest(new Request(
      `https://bridge.workers.dev/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: start.headers.get("Set-Cookie").split(";")[0] } },
    ), env);
    const html = await callback.text();
    assert.match(html, /account_not_allowed/);
    assert.doesNotMatch(html, /temporary-github-user-token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatch requires the exact Pages origin and a signed owner session", async () => {
  const wrongOrigin = new Request("https://bridge.workers.dev/api/dispatch", {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ youtube_url: "https://youtu.be/jNQXAC9IVRw" }),
  });
  const deniedOrigin = await handleRequest(wrongOrigin, baseEnv);
  assert.equal(deniedOrigin.status, 403);

  const noSession = new Request("https://bridge.workers.dev/api/dispatch", {
    method: "POST",
    headers: { Origin: baseEnv.PAGES_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ youtube_url: "https://youtu.be/jNQXAC9IVRw" }),
  });
  const deniedSession = await handleRequest(noSession, baseEnv);
  assert.equal(deniedSession.status, 401);

  const otherOwner = await createSessionToken("someone-else", "123", baseEnv);
  const deniedAccount = await handleRequest(new Request("https://bridge.workers.dev/api/dispatch", {
    method: "POST",
    headers: {
      Origin: baseEnv.PAGES_ORIGIN,
      Authorization: `Bearer ${otherOwner.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ youtube_url: "https://youtu.be/jNQXAC9IVRw" }),
  }), baseEnv);
  assert.equal(deniedAccount.status, 401);

  const expired = await createSessionToken("leweex95", "74991597", baseEnv, Date.now() - 11 * 60 * 1000);
  const deniedExpired = await handleRequest(new Request("https://bridge.workers.dev/api/dispatch", {
    method: "POST",
    headers: {
      Origin: baseEnv.PAGES_ORIGIN,
      Authorization: `Bearer ${expired.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ youtube_url: "https://youtu.be/jNQXAC9IVRw" }),
  }), baseEnv);
  assert.equal(deniedExpired.status, 401);
});

test("deployed placeholder Worker refuses dispatch until secrets are configured", async () => {
  const env = {
    ...baseEnv,
    GITHUB_APP_ID: "CONFIGURE_ME",
    GITHUB_APP_INSTALLATION_ID: "CONFIGURE_ME",
    GITHUB_APP_PRIVATE_KEY: "",
  };
  const session = await createSessionToken("leweex95", "74991597", env);
  const response = await handleRequest(new Request("https://bridge.workers.dev/api/dispatch", {
    method: "POST",
    headers: {
      Origin: env.PAGES_ORIGIN,
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ youtube_url: "https://youtu.be/jNQXAC9IVRw" }),
  }), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "bridge_not_configured" });
});

test("owner dispatch rejects unsupported modes, formats, and prompt overrides", async () => {
  const env = { ...baseEnv, GITHUB_APP_PRIVATE_KEY: "not-used-by-invalid-request" };
  const session = await createSessionToken("leweex95", "74991597", env);
  for (const body of [
    { youtube_url: "https://youtu.be/jNQXAC9IVRw", request_id: "0123456789abcdef0123456789abcdef", mode: "untrusted" },
    { youtube_url: "https://youtu.be/jNQXAC9IVRw", request_id: "0123456789abcdef0123456789abcdef", output_language: "en; malicious" },
    { youtube_url: "https://youtu.be/jNQXAC9IVRw", request_id: "0123456789abcdef0123456789abcdef", output_language: "x".repeat(36) },
    { youtube_url: "https://youtu.be/jNQXAC9IVRw", request_id: "0123456789abcdef0123456789abcdef", output_language: "hu" },
    { youtube_url: "https://youtu.be/jNQXAC9IVRw", request_id: "0123456789abcdef0123456789abcdef", formats: ["detailed"] },
    { youtube_url: "https://youtu.be/jNQXAC9IVRw", request_id: "0123456789abcdef0123456789abcdef", prompt_overrides: { concise: "missing placeholders" } },
  ]) {
    const response = await handleRequest(new Request("https://bridge.workers.dev/api/dispatch", {
      method: "POST",
      headers: {
        Origin: env.PAGES_ORIGIN,
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }), env);
    assert.equal(response.status, 400);
  }
});

test("owner dispatch uses a short-lived session and a narrowly scoped installation token", async () => {
  const generated = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
  const der = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
    .export({ format: "pem", type: "pkcs1" });
  const env = {
    ...baseEnv,
    GITHUB_APP_PRIVATE_KEY: der.toString(),
  };
  const session = await createSessionToken("leweex95", "74991597", env);
  const calls = [];
  const commitStatuses = [];
  const sha = "a".repeat(40);
  const runRecord = {
    id: 123,
    display_title: "YouTube summary request 0123456789abcdef0123456789abcdef",
    head_sha: sha,
    status: "in_progress",
    updated_at: "2026-11-18T12:00:00Z",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/app/installations/67890/access_tokens")) {
      return Response.json({ token: "temporary-installation-token" }, { status: 201 });
    }
    if (url.endsWith("/actions/workflows/summarize.yml/dispatches")) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/actions/runs/123/cancel")) return new Response(null, { status: 202 });
    if (url.includes("/contents/prompts/")) {
      return Response.json({
        encoding: "base64",
        content: Buffer.from("Template {transcript} {output_language}").toString("base64"),
      });
    }
    if (url.endsWith("/actions/runs/123")) return Response.json(runRecord);
    if (url.includes("/actions/workflows/summarize.yml/runs?")) return Response.json({ workflow_runs: [runRecord] });
    if (url.endsWith(`/statuses/${sha}`) || url.includes(`/commits/${sha}/statuses`)) {
      if (init.method === "POST") {
        const status = JSON.parse(init.body);
        commitStatuses.unshift({ ...status, updated_at: "2026-11-18T12:01:00Z" });
        return Response.json(status, { status: 201 });
      }
      return Response.json(commitStatuses);
    }
    throw new Error("unexpected upstream request");
  };

  try {
    const request = new Request("https://bridge.workers.dev/api/dispatch", {
      method: "POST",
      headers: {
        Origin: env.PAGES_ORIGIN,
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        youtube_url: "https://youtu.be/jNQXAC9IVRw?si=private-tracker",
        request_id: "0123456789abcdef0123456789abcdef",
        mode: "chunked",
        output_language: "en-US",
        formats: ["concise", "detailed"],
        prompt_overrides: { concise: "Summary in {output_language}: {transcript}" },
      }),
    });
    const response = await handleRequest(request, env);
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.deepEqual({ ok: result.ok, request_id: result.request_id, actions_url: result.actions_url }, {
      ok: true,
      request_id: "0123456789abcdef0123456789abcdef",
      actions_url: "https://github.com/leweex95/youtubesum/actions/workflows/summarize.yml",
    });
    assert.match(result.status_token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(result.cancel_token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/app\/installations\/67890\/access_tokens$/);
    assert.match(calls[1].url, /\/repos\/leweex95\/youtubesum\/actions\/workflows\/summarize\.yml\/dispatches$/);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      repositories: ["youtubesum"],
      permissions: { actions: "write" },
    });
    const dispatch = JSON.parse(calls[1].init.body);
    assert.equal(dispatch.ref, "main");
    assert.equal(dispatch.inputs.youtube_url, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
    assert.equal(dispatch.inputs.request_id, "0123456789abcdef0123456789abcdef");
    assert.match(dispatch.inputs.status_token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(dispatch.inputs.summary_mode, "chunked");
    assert.equal(dispatch.inputs.output_language, "en-US");
    assert.equal(dispatch.inputs.summary_formats, "concise,detailed");
    assert.deepEqual(JSON.parse(dispatch.inputs.prompt_overrides), {
      concise: "Summary in {output_language}: {transcript}",
    });

    const cancelResponse = await handleRequest(new Request(
      "https://bridge.workers.dev/api/cancel/0123456789abcdef0123456789abcdef",
      {
        method: "POST",
        headers: {
          Origin: env.PAGES_ORIGIN,
          Authorization: `Bearer ${result.cancel_token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    ), env);
    assert.equal(cancelResponse.status, 202);
    assert.deepEqual(await cancelResponse.json(), { ok: true, state: "cancelling" });
    assert.match(calls[4].url, /\/actions\/runs\/123\/cancel$/);
    assert.equal(calls[4].init.method, "POST");

    const wrongRequestCancel = await handleRequest(new Request(
      "https://bridge.workers.dev/api/cancel/ffffffffffffffffffffffffffffffff",
      {
        method: "POST",
        headers: {
          Origin: env.PAGES_ORIGIN,
          Authorization: `Bearer ${result.cancel_token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    ), env);
    assert.equal(wrongRequestCancel.status, 401);

    const progress = await handleRequest(new Request("https://bridge.workers.dev/api/progress", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dispatch.inputs.status_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_id: "0123456789abcdef0123456789abcdef",
        run_id: "123",
        state: "summary_ready",
      }),
    }), env);
    assert.equal(progress.status, 202);
    assert.deepEqual(commitStatuses[0], {
      state: "pending",
      context: "youtubesum/request/0123456789abcdef0123456789abcdef",
      description: "Summary generated",
      target_url: "https://github.com/leweex95/youtubesum/actions/workflows/summarize.yml",
      updated_at: "2026-11-18T12:01:00Z",
    });

    const status = await handleRequest(new Request(
      "https://bridge.workers.dev/api/status/0123456789abcdef0123456789abcdef",
      { headers: { Origin: env.PAGES_ORIGIN, Authorization: `Bearer ${result.status_token}` } },
    ), env);
    const statusResult = await status.json();
    assert.equal(status.status, 200);
    assert.equal(statusResult.state, "running");
    assert.equal(statusResult.message, "Summary generated");
    assert.deepEqual(statusResult.events.map((event) => event.message), ["Summary generated"]);

    runRecord.status = "completed";
    runRecord.conclusion = "cancelled";
    const cancelledStatus = await handleRequest(new Request(
      "https://bridge.workers.dev/api/status/0123456789abcdef0123456789abcdef",
      { headers: { Origin: env.PAGES_ORIGIN, Authorization: `Bearer ${result.status_token}` } },
    ), env);
    const cancelledResult = await cancelledStatus.json();
    assert.equal(cancelledResult.state, "cancelled");
    assert.equal(cancelledResult.message, "The request was cancelled.");

    const catalogResponse = await handleRequest(new Request("https://bridge.workers.dev/api/prompts", {
      headers: { Origin: env.PAGES_ORIGIN, Authorization: `Bearer ${session.token}` },
    }), env);
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200);
    assert.equal(Object.keys(catalog.prompts).length, 7);
    assert.equal(catalog.prompts["system:final_synthesis.md"], "Template {transcript} {output_language}");
    const tokenPermissions = calls
      .filter((call) => call.url.endsWith("/access_tokens"))
      .map((call) => JSON.parse(call.init.body).permissions);
    assert.deepEqual(tokenPermissions, [
      { actions: "write" },
      { actions: "write" },
      { actions: "read", statuses: "write" },
      { actions: "read", statuses: "read" },
      { actions: "read", statuses: "read" },
      { contents: "read" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
