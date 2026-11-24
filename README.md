# YouTube Summary Desk

Public GitHub Pages landing page for the private YouTube summarizer. The site is static and contains no credentials or processing code.

## Deploy with GitHub Pages

The `Deploy GitHub Pages` workflow publishes the site automatically from `main`. It can also be run manually from a `feature/*` branch for debugging. GitHub Pages has one public URL, so a feature deployment replaces the currently displayed site until the next deployment. Manual deployments from `main` and other branches are blocked. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.

## Request flow

The page is a static frontend. Once configured, it signs the owner in with GitHub and submits one YouTube URL to the Cloudflare Worker in `worker/`. The Worker verifies the allow-listed GitHub account and uses a narrowly scoped GitHub App installation token to dispatch `workflow_dispatch` in the private processing repository. While the request is queued or running, the page can request cancellation of that specific workflow run. No GitHub access token, App private key, SMTP data, summaries, or transcripts are placed in this repository or returned to the browser. The browser receives only short-lived, request-scoped tokens held in memory.

The form deliberately stays unavailable until `app.js` is configured with the deployed Worker URL and the complete authenticated dispatch flow is tested. See [`worker/SETUP.md`](worker/SETUP.md). Never place GitHub tokens, App private keys, Kaggle credentials, SMTP secrets, or private workflow results in this public repository.

The Pages deployment uploads `index.html`, `how-it-works.html`, `styles.css`, and `app.js`; Worker source and setup files are not published as site assets. The request form remains disabled until the full sign-in-to-email flow is verified.

## Related private processing repository

The summarizer and self-hosted runner workflow live in [`leweex95/youtubesum`](https://github.com/leweex95/youtubesum), which is private. Processing requires the owner's Windows PC to be online and signed into the interactive account used by TextGenHub.
