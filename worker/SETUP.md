# Configure the authenticated submission bridge

The Pages site is static and cannot safely hold a credential for the private repository. This Cloudflare Worker verifies the owner's GitHub sign-in, then uses a short-lived GitHub App installation token server-side to dispatch only `summarize.yml` in `leweex95/youtubesum`. It does not accept arbitrary recipients, return job output, or store request URLs. The GitHub OAuth token used to identify the owner is discarded after the account check. The browser receives only a 10-minute bridge session token, held in memory and limited to this dispatch endpoint.

The Worker source is public in this repository. Keep all private keys and client secrets in Cloudflare Worker secrets. Never add them to GitHub Pages, this repository, browser JavaScript, or Actions logs.

## Prerequisites

- A Cloudflare account with Workers enabled. This uses `workers.dev`; it does not use Cloudflare Tunnel or Access and does not require a VPS or home server.
- A GitHub App owned by `leweex95`, installed only on the private `youtubesum` repository.
- Node.js and npm on the setup computer.
- The private workflow must be available on `main`, and the self-hosted runner must be configured. The runner must have Kaggle credentials accessible to its interactive Windows account before real requests can succeed.

## 1. Deploy the Worker skeleton

From `worker/`, install/run Wrangler and authenticate to Cloudflare:

```powershell
npx wrangler@4 login
npx wrangler@4 deploy
```

Copy the resulting `workers.dev` URL. The placeholder App identifiers intentionally leave sign-in and dispatch unavailable.

## 2. Create the GitHub App

Create an app under the owner's GitHub account in **Settings → Developer settings → GitHub Apps → New GitHub App**.

- Homepage URL: `https://leweex95.github.io/youtubesum-pages/`
- User authorization callback URL: `<Worker URL>/auth/callback`.
- Enable the user-authorization flow so the Worker can verify the signed-in owner.
- Account permissions: **Profile: Read-only**, so the Worker can verify the GitHub numeric user ID and login.
- Repository permissions: **Actions: Read and write**. Leave other permissions at their minimum/default; GitHub's required Metadata read permission is fine.
- Subscribe to no webhook events.
- Install it only on the private `leweex95/youtubesum` repository.

Record the App ID, Client ID, Client Secret, private key, and installation ID. The App ID, Client ID, and installation ID are identifiers; the Client Secret and private key are credentials. Do not commit the private key or Client Secret.

Set the three non-secret identifiers in `worker/wrangler.toml` under `[vars]`:

- `GITHUB_APP_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_INSTALLATION_ID`

Create a fresh random session-signing secret locally and enter it only at the Wrangler prompt:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
npx wrangler@4 secret put GITHUB_APP_CLIENT_SECRET
npx wrangler@4 secret put GITHUB_APP_PRIVATE_KEY
npx wrangler@4 secret put SESSION_SIGNING_SECRET
```

Paste the GitHub App Client Secret, the full PEM private key, and the generated random value at their respective prompts. Do not put any of these values into `wrangler.toml`. Deploy again after updating variables/secrets:

```powershell
npx wrangler@4 deploy
```

The Worker URL is public configuration, not a secret. Add it as `BRIDGE_URL` in `app.js`, without a trailing slash. Run the Worker tests and review the public Pages diff before pushing. The Pages deployment workflow publishes only `index.html`, `styles.css`, and `app.js`; it does not publish Worker source or setup notes as site assets.

Also narrow the `connect-src` entry in the Content-Security-Policy meta tag in `index.html` from `https://*.workers.dev` to the exact Worker origin.

## 3. Verify before enabling public submissions

1. Run `node --test worker/test/index.test.js` and `node --check app.js`.
2. Check `https://<worker-host>/health`; it should return only `{"ok":true}`.
3. Push the Pages changes and confirm the Pages deployment succeeds.
4. In a private browser session, verify a non-owner GitHub account is denied. Do not enter or log any GitHub token in the page.
5. Sign in as `leweex95`, submit one test video with captions, and verify the Worker accepts only that URL and GitHub dispatches the private workflow.
6. Verify the Windows runner has Kaggle credentials, processing completes, and the owner receives the MP3 attachment. Confirm the public page shows only that the request was accepted and a link to the private Actions page—not the video URL, summary, transcript, logs, or credentials.
7. Test invalid URLs, playlist links, expired sessions, and a request from an unapproved account; none should dispatch a workflow.

Keep `BRIDGE_URL` empty and the form disabled until all steps above pass. The private Actions form remains available as a fallback. A queued run is not durable: the Windows PC must be online, and an offline runner's queued job may expire after about 24 hours.

## Security notes

- GitHub OAuth happens in a popup. The Worker checks both the GitHub numeric user ID and login against `worker/wrangler.toml`; the GitHub OAuth access token never reaches the browser. The browser receives a short-lived, dispatch-only bridge session token; if popup messaging is unavailable, it is handed off in a URL fragment that `app.js` immediately removes. URL fragments are not sent to the site server or in referrers.
- The bridge session is HMAC-signed, expires after 10 minutes, and is held in page memory only. Refreshing the page requires sign-in again.
- The Worker accepts POSTs only from the exact Pages origin, validates/canonicalizes one YouTube video URL, and strips query parameters before dispatch.
- Each dispatch receives a fresh installation token scoped to the private `youtubesum` repository and Actions write permission. It is never returned to the page.
- The Worker has no endpoint for logs, artifacts, transcripts, summaries, SMTP configuration, or runner details.
- Keep the public repository's workflows limited to Pages deployment from trusted `main`; do not add pull-request jobs that receive Cloudflare deployment secrets.
