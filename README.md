# Forgesite

> **SiteForge ERP** — a browser-based construction ERP for field-to-office cost certification.
> No build step, no framework: plain HTML/CSS/JS on top of Supabase.

[![CI](https://github.com/hamedalkitbi/Forgesite/actions/workflows/ci.yml/badge.svg)](https://github.com/hamedalkitbi/Forgesite/actions/workflows/ci.yml)
[![HTMLHint](https://github.com/hamedalkitbi/Forgesite/actions/workflows/htmlhint.yml/badge.svg)](https://github.com/hamedalkitbi/Forgesite/actions/workflows/htmlhint.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What it does

SiteForge is a browser-based ERP prototype that helps site engineers and
commercial teams track certified quantities, costs and approvals from the
field to the office:

- **BOQ** — bill-of-quantities import (Excel/CSV via SheetJS), sections, rates, certified quantities
- **Progress billing (IPC)** — cumulative valuation, retention, advance recovery, printable tax invoice
- **Cost control** — expenses, company budget, materials/POs, payments, change orders, parties
- **Field operations** — timesheets, payroll batches, workers & staff, compliance, site reports, drawings, timeline
- **Governance** — role-based views (director/controller/superintendent/tradesperson), approval workflow with exposure preview, immutable audit trail, notifications
- **Extras** — client-side OCR bill scanner (Tesseract), Arabic/English UI, dark/light theme

## Quick start

No build step required. Serve the folder over HTTP (opening `index.html` directly
from disk breaks the service worker and some browser APIs):

```bash
npm run serve          # python3 -m http.server 8899 --bind 127.0.0.1
# or
python3 -m http.server 8899
```

Then open <http://127.0.0.1:8899/>.

Sign-in talks to the Supabase project configured at the top of `scripts/app.js`
(`SUPABASE_URL` / `SUPABASE_ANON_KEY`). You need a valid account in that project;
there is no local/demo mode.

## Repository layout

| Path | Purpose |
|------|---------|
| `index.html` | App shell: login screen, topbar, sidebar, `#main` mount point |
| `scripts/app.js` | Entire application logic (one IIFE, ~3.1k lines) |
| `styles/main.css` | Theme tokens, layout, dark/light, print styles |
| `sw.js` | Service worker: offline app shell + CDN caching |
| `site.webmanifest` | PWA manifest (installable, standalone display) |
| `icons/` | App icons — `icon.svg` is the source; PNGs are generated |
| `tools/` | Zero-dependency dev tooling: tests, smoke test, icon renderer, screenshots, CDP lib |
| `docs/` | `ENHANCEMENTS.md` (shipped + backlog), `audits/` (data, UX/a11y, architecture), `screenshots/` |
| `.github/workflows/` | `ci.yml` (lint + headless tests), `pages.yml` (GitHub Pages deploy) |
| `apply_all.py`, `fix_anchors.py` | **Historical** patch scripts — see below |

## Accessibility

The shell targets WCAG 2.2 AA for its own chrome:

- sidebar navigation is real `<button>`s with `aria-current`; **modals** move focus in, trap Tab,
  and restore focus on close; **Escape** closes the dialog, notifications and the mobile drawer
- login/form errors use `role="alert"`, toasts use a persistent `role="status"` live region
- generated form fields have `label[for]`, `aria-required`, and focus the first invalid field
- skip link to `#main`, visible `:focus-visible` rings, icon-only buttons have accessible names
- light-theme contrast tokens: `--muted` and `--accent-ink` are AA on their surfaces; fills stay orange
- reduced-motion support; RTL uses logical properties (two double-flips removed)

Screenshots: [`docs/screenshots/`](docs/screenshots/). Audit: [`docs/audits/ux-a11y.md`](docs/audits/ux-a11y.md).

## Offline & installable (PWA)

`sw.js` precaches the app shell and the two version-pinned CDN libraries, so the
app boots without a network connection (Supabase calls then fail with the usual
offline toast until you reconnect).

| Request | Strategy |
|---|---|
| Navigation | network-first, cached shell as fallback |
| Same-origin `GET` | stale-while-revalidate |
| Pinned CDN (`cdn.sheetjs.com`, `cdn.jsdelivr.net`, `unpkg.com`) | cache-first |
| Everything else (Supabase REST/auth/realtime, OCR workers) | network only — never cached |

Notes:

- The worker only registers on **https** or **localhost/127.0.0.1**. Add `?nosw=1`
  to any URL to bypass it (useful while debugging).
- After changing `index.html`, `scripts/app.js` or `styles/main.css`, **bump
  `VERSION` in `sw.js`** so returning visitors get the new shell; stale caches are
  pruned on `activate`.
- To unregister during development: DevTools → Application → Service Workers → Unregister.
- Installing requires a secure context, which is why GitHub Pages (https) is the
  recommended host.

## Testing

The suite is dependency-free (Node ≥ 20 + a local Chrome/Chromium); it starts its
own static server and a headless browser over the DevTools Protocol, then cleans up.

```bash
npm test               # 43 checks: assets, PWA, runtime, helpers, a11y, Arabic RTL, offline
npm run smoke          # load the app once and fail on any console error / 4xx
npm run icons          # re-render icons/*.png from icons/icon.svg
```

`npm test` covers:

1. every static asset (HTML, CSS, JS, SW, manifest, icons) is served
2. `scripts/app.js` and `sw.js` parse; manifest has the fields installability needs
3. the app boots with **zero** JS exceptions, CDN globals present, login screen rendered
4. pure helpers behave (`money`, `numOr`, `esc`, date handling, XSS sinks, `genUUID`)
5. accessibility basics: document language, labelled inputs, dialog role, skip link, ARIA
   live regions, accessible names for icon-only buttons
6. the login shell localizes to Arabic and switches to RTL
7. the service worker registers, **precaches both CDN libraries**, and the app renders offline
8. source invariants stay fixed (button-based nav, modal focus trap, load-generation guard,
   verified deletes, live regions) — a regression here fails CI

If Chrome is not in a standard location, set `CHROME_PATH=/path/to/chrome`.

## Deployment

Any static host works (GitHub Pages, Netlify, S3/CloudFront, nginx) — serve the
repository root and use **https**, or the service worker will not register.

`pages.yml` deploys `main` to GitHub Pages; enable it once in
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Backend & security notes

- `SUPABASE_ANON_KEY` is a *public* key by design: it identifies the project and is
  safe to ship in client code **only if Row Level Security is enabled and correct on
  every table**. All access control then lives in RLS policies, not in this repo.
- Never put a `service_role` key in this repository — it bypasses RLS entirely.
- Auth tokens are handled by supabase-js (localStorage/sessionStorage); the app
  stores only the remembered *username* itself.
- The app is a single-page prototype without a backend of its own; do not treat
  client-side role checks (`PERMS`) as a security boundary.

## Historical patch scripts

> `apply_all.py` and `fix_anchors.py` target the **pre-refactor** single-file
> layout. They are kept for historical reference and will not run cleanly against
> the current tree — several anchors now live in `styles/main.css` and
> `scripts/app.js`. Do not run them without inspecting the source first.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Reports of security issues: [SECURITY.md](SECURITY.md).
