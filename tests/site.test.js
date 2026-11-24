import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("request page links to the public walkthrough and starts disabled", async () => {
  const html = await read("index.html");
  assert.match(html, /href="how-it-works\.html"/);
  assert.match(html, /id="sign-in"[^>]*disabled/);
  assert.match(html, /id="video-url"[^>]*disabled/);
  assert.match(html, /id="submit-request"[^>]*disabled/);
  assert.match(html, /id="summary-mode"/);
  assert.match(html, /id="output-language"[^>]*value="en"/);
  assert.match(html, /id="library-tab"[^>]*disabled/);
  assert.match(html, /id="library-view"[^>]*hidden/);
  assert.match(html, /id="prompt-editor"/);
  assert.match(html, /id="progress-panel"/);
  assert.match(html, /id="cancel-request"[^>]*hidden>Cancel request/);
});

test("request bridge is configured and owner submissions are enabled after end-to-end verification", async () => {
  const script = await read("app.js");
  assert.match(script, /const BRIDGE_URL = "https:\/\/youtubesum-submit\.csibi-levente14\.workers\.dev"/);
  assert.match(script, /const SUBMISSIONS_ENABLED = true/);
  assert.match(script, /The Windows runner must be online/);
  assert.match(script, /\/api\/cancel\//);
  assert.match(script, /cancel_token/);
});

test("walkthrough explains the data boundary and practical limits", async () => {
  const html = await read("how-it-works.html");
  assert.match(html, /A server checks and tracks the request/);
  assert.match(html, /Worker returns saved summaries only after verifying the owner's sign-in/);
  assert.match(html, /private D1 database/);
  assert.match(html, /regular code with explicit tests/);
  assert.match(html, /not a durable job service/);
});

test("Pages deploys main automatically and allows manual feature previews only", async () => {
  const workflow = await read(".github/workflows/pages.yml");
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /refs\/heads\/feature\//);
});
