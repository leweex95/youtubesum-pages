# YouTube Summary Desk

Public GitHub Pages landing page for the private YouTube summarizer. The site is static and contains no credentials or processing code.

## Deploy with GitHub Pages

The `Deploy GitHub Pages` workflow publishes the site from the `main` branch. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. The first deployment runs on push to `main`.

## Current status

The page is intentionally a public-facing preview: request fields are disabled until the private Windows runner is installed and tested and an authenticated server-side bridge is ready. Do not add a GitHub token or private runner details to this repository. The future page should send requests only to the authenticated bridge; it must never call the private repository with browser-held credentials.

## Related private processing repository

The summarizer and self-hosted runner workflow live in [`leweex95/youtubesum`](https://github.com/leweex95/youtubesum), which is private. Processing requires the owner's Windows PC to be online and signed into the interactive account used by TextGenHub.
