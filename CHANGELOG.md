# Changelog

All notable changes are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [29.2.0] - 2026-11-03

### Added
- Payment Requests module (subcontractors & suppliers): retention + advance recovery,
  submit → approve/reject → pay, ageing, printable request document; feeds the
  Executive Approvals Queue
- Financial Accounts module: company-wide receivables, payables/ageing, derived
  balance sheet (identity holds by construction) and P&L/project profitability,
  CSV export and branded print/PDF
- Payslips module: batch generation from approved timesheets, editable preview,
  idempotent save per worker/period, per-slip and bulk print/PDF, loan deduction
  capped with carry-forward
- `window.SF` module bridge (`registerView`, `navItems`, `db.selectStrict`, `db.upsert`,
  `ui.*`, approval-source hooks) so features live in `scripts/modules/`
- Migrations: `payment_requests`, `finance_settings`, `payslips`, PO approval columns,
  `site_reports.photos` jsonb, `siteforge-files` bucket + storage policies
- Mock-Supabase harness + `withApp` testkit (`tools/lib/mock-supabase.mjs`,
  `tools/lib/testkit.mjs`), authenticated view smoke (`tools/tests/app-views.mjs`),
  per-module checks and an independent cross-module math audit

### Changed
- Approvals: decisions use a `status='pending'` CAS, record approver and timestamp,
  rejections carry a reason, and module items join one queue
- POs show the approving manager; batch approval logs only items that actually succeeded
- Payroll loan deduction is capped at salary as well as the outstanding loan, with the
  shortfall carried forward

### Fixed
- Site-report photos were embedded as base64 in the row (payload limits + silent column
  drop meant pictures never saved); they now upload to Supabase Storage with signed-URL
  thumbnails and explicit failure messages; deleting a report removes its objects

## [29.1.0] - 2026-11-03

### Added

### Added
- PWA: `site.webmanifest`, offline app-shell service worker (`sw.js` with versioned
  caches; navigation network-first, same-origin stale-while-revalidate, pinned CDN
  cache-first, Supabase traffic never cached), generated icon set
  (192/512/maskable/apple-touch) rendered from `icons/icon.svg`
- Meta: description, `theme-color`, `color-scheme`, `viewport-fit=cover`,
  preconnect/dns-prefetch hints, `<noscript>` fallback
- Zero-dependency test tooling: `tools/run-tests.mjs` (43 checks: static assets,
  PWA manifest, headless runtime smoke, pure-helper unit tests, accessibility,
  Arabic RTL, source invariants, SW CDN precache, offline shell),
  `tools/smoke.mjs`, `tools/make-icons.mjs`, `tools/screenshots.mjs`,
  `tools/lib/cdp.mjs` DevTools-Protocol driver
- `package.json` scripts (`serve`, `test`, `smoke`, `icons`)
- CI workflow (HTMLHint + JS syntax + headless test suite) and a GitHub Pages
  deploy workflow
- Audit reports and backlog: `docs/audits/` (data, UX/a11y, architecture),
  `docs/ENHANCEMENTS.md`, `docs/screenshots/`

### Changed
- `index.html` references the manifest/icons and registers the service worker on
  https/localhost (`?nosw=1` opt-out)
- Accessibility: sidebar navigation is `<button>` + `aria-current`; modals move
  focus in, trap Tab and restore it; form fields get `label[for]`,
  `aria-required`, `aria-invalid` and focus the first invalid field; login/form
  errors are `role="alert"`; toasts use a persistent `role="status"` live region;
  icon-only buttons get accessible names; skip link to `#main`; global
  `:focus-visible` rings; `prefers-reduced-motion` support
- Contrast: light theme `--muted` darkened to AA, new `--accent-ink` token for
  text/icons (fills keep the accent), `AED` pill and white-on-red fixed
- RTL: removed two double-flips (sidebar, modal footer), switched to logical
  properties (`border-inline-end`, `inset-inline-*`, `margin-inline-start`)
- Login shell is fully bilingual: aside copy, tagline, placeholders, `<title>`
  and the mirrored CTA arrow follow the language setting
- README rewritten: layout, offline behavior, accessibility, testing,
  deployment and backend/RLS notes

### Fixed
- Removed the `favicon.ico` 404 (SVG app icon now served from `icons/icon.svg`)
- Data integrity: project-switch race (generation guard + rollback + cleared
  project caches) no longer leaves new project ids beside old rows; `deleteRow`
  verifies a row was actually removed; OCR bill commit writes an explicit
  `status`; audit-write failures are surfaced; `daysUntil` handles ISO timestamps
  (no more "in null d" alerts); next IPC number parses the trailing sequence;
  unhandled promise rejections reach the error banner (now dismissible)
- PWA: CDN libraries are precached with CORS + `cache.put` (opaque responses made
  `cache.add` reject); manifest `id` is relative so installs survive a host/path change

## [29.0.0] - 2026-11-03

### Changed
- Extracted inline CSS to `styles/main.css`
- Extracted inline JS to `scripts/app.js`
- `index.html` now references external assets instead of bundling them

### Added
- Project docs: README, LICENSE, CONTRIBUTING, SECURITY
- HTMLHint CI workflow
- Issue and PR templates

### Deprecated
- `apply_all.py` and `fix_anchors.py` marked historical — they target the
  pre-refactor single-file layout and will not run cleanly against the
  current tree

## [28.2] - 2026-11-02
### Changed
- (add your last release notes here)
