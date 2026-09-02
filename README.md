# Reel Reader — Instagram Reels URL Scraper

A local tool that logs into Instagram using an imported browser session (`cookie.json`)
and pulls the Reels URLs from a list of target profiles, via Playwright. Comes with a
small web UI for importing cookies and watching progress.

```
ig-reels-scraper/
├── package.json
├── server.js        # Express API: start job, poll status, download results
├── scraper.js        # Playwright logic: cookie handling, navigation, scrolling, extraction
├── public/
│   └── index.html    # UI — cookie import, profile list, live log, results table
└── README.md
```

## 1. Install

Requires Node.js 18+.

```bash
cd ig-reels-scraper
npm install
npx playwright install chromium   # downloads the browser binary Playwright drives
```

## 2. Export your Instagram cookies

You need a `cookie.json` from a browser where you're already logged into Instagram.

1. Log into instagram.com in Chrome/Firefox as normal.
2. Install a cookie-export extension, e.g. **Cookie-Editor** (Chrome/Firefox).
3. On instagram.com, open the extension → **Export** → **Export as JSON**.
4. Save the file as `cookie.json` somewhere you can find it.

The file should look like an array of cookie objects:

```json
[
  { "name": "sessionid", "value": "...", "domain": ".instagram.com", "path": "/", ... },
  { "name": "csrftoken", "value": "...", "domain": ".instagram.com", "path": "/", ... }
]
```

Treat this file like a password — it grants access to your logged-in session. Don't
commit it to git or share it (see `.gitignore` below).

## 3. Run it

```bash
npm start
```

Open **http://localhost:3000**, then:

1. Drop your `cookie.json` onto the import box (or click to browse).
2. Paste target usernames, one per line (with or without `@`).
3. Optionally cap reels-per-profile and scroll passes, or uncheck "headless" to watch
   the browser drive itself.
4. Click **Start scraping**. Progress streams into the log panel; results fill in the
   table as each profile finishes.
5. Download everything as JSON or CSV once the job completes.

## How it works

- The server normalizes your exported cookies into the shape Playwright expects
  (`expirationDate` → `expires`, `sameSite` string mapping, etc.) and loads them into
  a fresh browser context — no login flow is automated, it just reuses your existing
  session.
- For each username it opens `instagram.com/<username>/reels/`, scrolls a bounded
  number of times to trigger lazy-loading, and collects every `<a href>` containing
  `/reel/`, deduplicated.
- It distinguishes a few outcomes per profile: `ok`, `no_reels_found`, `private`,
  `login_wall` (cookies expired/invalid), `not_found`, and `error`.
- A small random delay runs between profiles to keep request pacing reasonable.

## Deploying to Render

The repo includes a `Dockerfile` (based on Playwright's own image, so Chromium and
its system deps are already installed) and a `render.yaml` Blueprint.

1. **Push this project to a GitHub repo.**
2. In Render, choose **New → Blueprint**, point it at the repo — it will read
   `render.yaml` and provision a Docker web service automatically. (Or skip the
   Blueprint and create a **New → Web Service** manually, environment **Docker**,
   pointing at the same Dockerfile.)
3. **Set `AUTH_USER` and `AUTH_PASS`** in the service's Environment tab. The app
   only enables HTTP Basic Auth when both are present — leaving them unset means
   anyone with the URL can upload cookies and trigger scrape jobs from your
   server, so set these before the service goes live.
4. Deploy. Once it's up, visiting the Render URL will prompt for the
   username/password you set, then load the same UI you ran locally.
5. **Plan size matters.** Headless Chromium wants real headroom — Render's free/
   starter tier (512MB) can OOM mid-scrape. `render.yaml` defaults to the
   `standard` plan; drop it back down only if you've confirmed smaller works for
   your usage.
6. **Cold starts / sleeping instances** (on lower tiers) will kill an in-progress
   browser session. For anything beyond occasional manual use, an always-on plan
   is worth it.

Each deploy gets its own outbound IP, and it's a datacenter IP rather than a
residential one — Instagram is more likely to rate-limit or challenge sessions
from it than from your home connection. If you start seeing `login_wall` results
that a fresh cookie export doesn't fix, that's usually why.

## Notes and limits

- **Terms of Service**: automated scraping conflicts with Instagram's ToS. This is
  built for personal/internal use against your own account's session — review the
  ToS and use your own judgment before pointing it at accounts you don't own, and
  keep volume modest.
- **Session cookies expire.** If every profile comes back `login_wall`, re-export a
  fresh `cookie.json`.
- **Instagram's markup changes.** The `/reel/` link selector is intentionally simple
  so it's easy to adjust in `scraper.js` (`collectReelUrls`) if the page structure
  changes.
- Jobs and their results live in server memory only (no database) and are dropped
  after 2 hours — this is meant for local, single-user use, not a hosted multi-user
  service.
