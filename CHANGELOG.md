# Changelog

All notable changes are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [29.4.0] - 2026-11-04

### Added
- **Server-side approvals (RPC)**: `sf_approve_record` / `sf_reject_record` move authority into
  Postgres (security-definer) with segregation of duties (creator cannot approve their own
  submission), a per-role/per-table limits-of-authority matrix (`approval_limits`, fail-closed),
  a pending/submitted CAS (no double-approve), and an append-only `approval_events` log
- **Global Suppliers & Contractors master** (`suppliers` + `project_suppliers`) with a company
  directory module, project linking, and wiring into POs, `ensureSupplier` and the PO → bill flow
- **Approvals inbox**: All / For me / By me tabs with age colouring (>3 days flagged overdue) and
  a per-record approval timeline
- `created_by` stamped on materials/BOQ/change orders/timesheets/expenses for SoD attribution
- Migration `202611050001_phase1_accountability.sql` (RLS on the new + approval-critical tables)

### Changed
- Version 29.4.0; service-worker cache `v29.4.0-1`

## [29.3.0] - 2026-11-04

### Added
- **Notifications & alerts are clearable**: "Mark all read" clears DB notifications *and*
  compliance/budget alerts; individual alerts can be dismissed (persisted per browser in
  `sf_dismissed_alerts_v2`), and the topbar badge/panel update immediately
- **Commitments vs actuals**: approved POs in `Ordered` / `In Transit` count as committed cost;
  only `Delivered` / `Inspected` / `Installed` hit BOQ actuals. BOQ shows committed + actual
- **PO → supplier payable invoice** (1 click): 5% UAE VAT, 30-day credit terms, registers the
  supplier in project parties, accrues the PO and posts the invoice to payables
- **BOQ line-by-line IPC valuation sheet** (percent executed per line → prefills the IPC gross
  valuation) and **IPC → receivables sync** for certified/paid certificates (idempotent by
  invoice number, 30-day due date)
- **Worker-linked timesheets** (`timesheets.worker_id`) and a **unified monthly payroll run**:
  basic salary + approved overtime at 1.5× − loan installment, updates each worker's loan
  balance, certifies the payroll batch and posts the salaries expense in one action
- **Approved change orders auto-create a BOQ variation line** under "Variations / Change Orders"
  so field teams can log cost against the variation
- **Cross-project executive approvals queue**: pending BOQ/PO/CO/timesheet/expense items are
  fetched company-wide after login, so the queue and badge work with no project selected
- **WebP site-report photos** (smaller uploads; falls back to JPEG where WebP is unsupported)
- **Compatibility surface for v28-era patch scripts** (`window.SiteForge`, `window.state` and
  function aliases) — fixes `Uncaught TypeError: Cannot read properties of undefined
  (reading 'boq')` when an old single-file patch module is loaded, and the new features above
  are native ports of that specification

### Changed
- Version 29.3.0; service-worker cache bumped to `v29.3.0-1`
- Migration added: `202611041001_worker_links_and_payroll.sql`

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
