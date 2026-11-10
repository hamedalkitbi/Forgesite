# Enhancement work — SiteForge ERP (`Forgesite`)

> Baseline imported from `github.com/hamedalkitbi/Forgesite` @ `43be218` (v29.0.0 refactor).
> This document records what was **shipped**, the **audit backlog** behind it, and the
> recommended order for the next phases. Three read-only audits were run against the
> baseline first; their full reports live in [`docs/audits/`](audits/).

- Branch: `enhance/pwa-and-tests`
- Audit findings: **30** data-layer, **29** UX/a11y, **24** architecture/security
- Test suite: `node tools/run-tests.mjs` → **43/43 passing**, including the offline app shell
- Screenshots: [`docs/screenshots/`](screenshots/) (dark, light, Arabic/RTL, mobile)

---

## 1. Shipped in this pass

### 1.1 Installable, offline-capable shell (PWA)

| Piece | Detail |
|---|---|
| `site.webmanifest` | standalone display, relative `id`/`start_url`/`scope` (portable across hosts), `any` + `maskable` icons |
| `sw.js` | versioned caches (`v29.1.0-1`); navigation network-first with cached shell fallback; same-origin stale-while-revalidate; pinned CDN cache-first; **Supabase REST/auth/realtime never cached**; old caches pruned on activate |
| Icons | `icons/icon.svg` source (pickaxe mark) → generated 192/512/maskable/apple-touch PNGs via `tools/make-icons.mjs` |
| `index.html` | manifest/icon links, description, `theme-color`, `color-scheme`, preconnect/dns-prefetch, `viewport-fit=cover`, `<noscript>` fallback, SW registration (https/localhost; `?nosw=1` opt-out) |

Fixed during this pass: the CDN precache used `cache.add()` on `no-cors` requests — an opaque
response has `status: 0`, so `add` rejects and `Promise.allSettled` hid it; the two libraries
were never precached. Now fetched with CORS and `cache.put`, and **asserted by a test**.

### 1.2 Test harness, CI and deploy

- `tools/lib/cdp.mjs` — dependency-free Chrome DevTools Protocol driver (Node ≥ 20, no npm install)
- `tools/run-tests.mjs` — **43 checks**: static assets, JS parse, manifest fields, source
  invariants, boot smoke, pure helpers, accessibility, Arabic RTL, SW registration/precache, offline render
- `tools/smoke.mjs` — one-shot load test, fails on any console error / 4xx
- `tools/make-icons.mjs`, `tools/screenshots.mjs`, `tools/lib/server.mjs`
- `package.json` scripts: `serve`, `test`, `smoke`, `icons`
- CI (`.github/workflows/ci.yml`): HTMLHint + JS syntax + headless suite; Pages deploy workflow
- `?selftest=1` surface in `scripts/app.js` exposes pure helpers to the suite only (production untouched)

### 1.3 Accessibility — the app's largest UX gap

Audit baseline: 3 ARIA attributes, 0 `tabindex`, 0 `aria-live`, 0 `:focus-visible`, 0 captions,
3 `for=` (login only), no skip link. Shipped:

- **Sidebar navigation is real `<button>`s** with `aria-current="page"` and `aria-hidden` decorative glyphs
  (previously 25 non-focusable `<div onclick>` — keyboard/AT users could not leave the first screen)
- **Modals**: focus moves into the dialog, Tab/Shift+Tab trapped inside `.mbox`, focus restored on close,
  `aria-labelledby` wired; Escape restores focus
- **Feedback is announced**: `role="alert"` on login/form errors, persistent `role="status"` toast host,
  `aria-live` on login status
- **Forms**: `<label for="f_key">`, `aria-required`, `aria-invalid` + focus on the first invalid field
- **Names for icon-only buttons** (☰ 🔔 🛡️ ✕ ✎ 🖨 ✓ …) via explicit labels + a render-time fallback pass
- **Keyboard**: skip link → `#main` (`tabindex="-1"`), Escape closes notifications and the mobile drawer,
  `aria-expanded` on both toggles
- **Contrast tokens**: light-theme `--muted` `#6b7580 → #57606a`, new `--accent-ink` (`#a34e00` in light)
  for text/icons, `AED` pill `1.29:1 → 7.04:1`, white-on-red fixed by dark ink on `#f85149`
- **Layout**: global `:focus-visible` ring, removed two RTL double-flips (sidebar, modal footer),
  logical properties (`border-inline-end`, `inset-inline-*`, `margin-inline-start`), 28px photo-delete target,
  `prefers-reduced-motion` support
- **Optional app shell is fully bilingual**: login aside copy, tagline, placeholders, `<title>` and RTL CTA arrow
  now follow the language setting (previously Arabic showed English marketing copy)

### 1.4 Data-integrity fixes (from the data audit)

| Fix | Where |
|---|---|
| **P0** project-switch race: new `state._loadGen` generation guard; state is only committed if still current; failures roll back instead of leaving the new project id beside the old project's rows; project caches cleared when returning to company level | `loadProjectData`, `switchProject`, `clearProjectState` |
| `deleteRow` verifies a row was actually removed (RLS can silently delete 0 rows) and reports it | `deleteRow` |
| OCR bill commit writes an explicit `status` (`approved` for managers, `pending` otherwise) instead of relying on a DB default | `commitScan` |
| Audit-write failures are surfaced ("Saved, but the audit-trail entry failed") instead of being swallowed | `logTransaction` |
| `daysUntil` parses ISO timestamps/date objects; unparseable dates no longer render "in null d" alerts | `daysUntil`, `collectAlerts` |
| Next IPC number parses the trailing sequence (`INV-2026-001 → PB-002`), not the first digit run | `getNextBillingNo` |
| Unhandled promise rejections reach the (now dismissible, auto-hiding) error banner | bootstrap |

---

## 1.5 Owner-requested feature wave (v29.2)

Five requested items shipped as modules behind the `window.SF` bridge, plus one bug fix and one
approval-system upgrade. `app.js` was touched only for the bridge, the approval queue and the
photo/approval fixes — feature code lives in `scripts/modules/`.

| Request | Status | Where |
|---|---|---|
| "OP needs an approval system" (Purchase Orders) | **Done** | POs and all approvable rows now decide with a `status='pending'` CAS, record `approved_by`/`approved_at`/`rejection_reason`, appear with the approver in the PO table, and feed one Executive Approvals Queue |
| Site report does not upload pictures | **Fixed** | Photos now upload to the `siteforge-files` bucket and rows store `[{name,path,size}]`; signed-URL thumbnails, legacy inline rows still render, deleting a report removes its objects |
| Subcontractor/supplier payment requests | **Done** | `scripts/modules/payment-requests.js` — retention + advance recovery, submit → approve/reject → pay, ageing, printable request, feeds the Executive Approvals Queue |
| Financial accounts: balance sheet, AR, AP | **Done** | `scripts/modules/finance-statements.js` — company-wide Receivables, Payables, derived Balance Sheet (balanced by construction) and P&L/project profitability, CSV + print |
| Payroll payslip generator | **Done** | `scripts/modules/payslips.js` — batch from approved timesheets, editable preview, idempotent save, per-slip and bulk print/PDF, loan deduction capped with carry-forward |
| "Check all calculations" | **Done** | 28/28 hand-computed independent checks + 40 finance + 38 payment-request + 35 payslip checks + 51 app checks + 31 authenticated view checks (see §4) |

**Why site-report photos silently failed:** `saveSiteReport` embedded each compressed JPEG as a
base64 `data:` URL inside the `site_reports.photos` JSON column. Large/multiple photos exceed the
row payload limits, and the app's "unknown column" tolerance would drop the column and still toast
*Saved* — so pictures vanished with no error. Uploads now happen before the row is written and a
failed upload aborts the save with an explicit message.

**Database changes:** four idempotent migrations under `supabase/migrations/` (see §5). Modules
render a "needs a database update" card naming the file until they are applied.

**Independently verified numbers** (hand-computed fixture, not the modules' own fixtures):
AR = 13,500 certified − 4,000 received = **9,500**; AP = **3,900** (PR net 900 + unpaid supplier
3,000); cash **500**; retention **1,500**; VAT **675**; assets **10,000**; liabilities **6,075**;
equity **3,925**; balance-sheet diff **0.00**; P&L revenue **13,500**, gross **11,000**, net
**9,000**; payslip 8h@25 + 2h OT → gross **275**, loan capped at gross → net **0**, shortfall
**225**; payment-request 1000 @ 2.5% → retention **25.00**, net **975.00**.

### Review item resolved

- **AR vs `status='paid'` certificates:** finance-dev adopted *status-aware settlement* —
  paid certificates are settled by status (out of AR, ageing rows and the Overdue KPI), recorded
  receipts are consumed by paid certificates first (no double count) and then FIFO against open
  certified invoices, with leftovers shown as a client-advance credit row. The Receivables tab,
  CSV and print pack now include a "Settlement reconciliation" line. Closed form:
  `AR = Σ net_payable(certified) − max(0, receipts − Σ net_payable(paid))`. Covered by 7 new
  regression checks (47/47 in the finance suite).

## 1.6 Workflow upgrade wave (v29.3)

A specification for seven workflow upgrades arrived as a **monolith-era override module**
(`gemini-code-*.js`). It expected `window.SiteForge.state` / `window.state` and replaced globals
such as `window.newTimesheet`; in the v29 architecture those are private to the `app.js` IIFE,
so `getState()` returned `undefined` and line 389 threw
`Cannot read properties of undefined (reading 'boq')`.

Rather than shipping a shim, the behaviour was **ported natively** and a compatibility surface
(`window.SiteForge`, `window.state`, function aliases) was added so old patch files no longer
crash the app.

| Feature | Implementation |
|---|---|
| Clearable notifications & alerts | dismissals persisted (`sf_dismissed_alerts_v2`); DB `notifications.is_read` updated; badge + panel refresh |
| Commitments vs actuals | PO stage gate in `getBoqActualsMap` + new `getBoqCommittedMap`; BOQ shows both |
| PO → supplier bill | `convertPOToBill`/`commitPOBill`: 5% VAT, 30-day terms, supplier auto-register, AP entry, PO accrues |
| BOQ valuation → IPC | `openBoqValuationSheet` / `recalcBoqValuation` / `applyBoqValuationToIPC` |
| IPC → AR sync | `syncIPCToReceivables` on certified/paid, idempotent by invoice no, 30-day due |
| Worker-linked timesheets | `timesheets.worker_id` (migration 202611041001) + worker select in the form |
| Unified payroll run | basic + 1.5× approved OT − loan, loan balance update, payroll batch, salaries expense |
| Variation lines | approved change order creates a BOQ line under "Variations / Change Orders" |
| Cross-project queue | company-wide pending fetch after login; queue + badge populated with no project open |
| WebP photos | canvas → `image/webp` (JPEG fallback), uploaded to the `siteforge-files` bucket |

Verified by `node tools/checks/upgrade-wave.mjs` (11 checks) plus the existing 231 checks.

## 1.7 Phase 1 accountability + global supplier/contractor master (v29.4)

- Authority moved server-side: `sf_approve_record` / `sf_reject_record` RPCs enforce role,
  limits-of-authority (`approval_limits`, fail-closed; director unlimited), segregation of duties
  and a `status in ('pending','submitted')` CAS, and write an append-only `approval_events` row.
- Company-wide `suppliers` master + `project_suppliers` links, with a "Suppliers & Contractors"
  directory module and wiring into `ensureSupplier` / PO → bill.
- Approvals inbox (All / For me / By me) + age colouring + per-record timeline.
- `created_by` stamped on new operational rows for SoD attribution.
- Migration `202611050001_phase1_accountability.sql`; RLS on new + approval-critical tables.

Verified by `tools/checks/phase1.mjs` (15) and `tools/checks/suppliers.mjs` (12).

## 1.8 Phase 2 — evidence, period close, SLA, 3-way match (v29.5)

- Evidence attachments (`approval_attachments` + per-table amount rules) with uploader-only
  delete; above-threshold approvals require evidence.
- Period close (`closed_periods`) enforced by the app guard and DB triggers on the six dated
  tables; directors close/reopen from the queue header.
- Approval SLA (`approval_sla`) + `sf_escalate_overdue()` (and optional pg_cron) + Overdue filter.
- 3-way match: Goods Received Notes (`goods_received_notes`, `sf_material_grn`) gate PO billing
  and supplier payment; Receiving/GRN module shows received vs ordered with match badges.
- Migration `202611050002_phase2_workflow.sql`.

Verified by `tools/checks/phase2.mjs` (16) and `tools/checks/grn.mjs` (10).

## 1.9 Expense bill/PO + submission notifications (v29.7)

- Fixed the `record "new" has no field "company_id"` failure when adding a company expense: the
  Phase 2 closed-period guard read a column `company_expenses` never had. The new migration adds
  `company_id` (single-company backfill only) and rewrites `sf_guard_closed_period()` so a missing
  column can never raise. The app stamps `company_id` on every expense write.
- New/Edit expense now share one modal with **bill upload + OCR scan** (photo or PDF) stored as
  `bill_path` under `company/bills/` in `siteforge-files`, and an optional **PO #** (`po_number`,
  datalist of existing POs) surfaced in the expenses table, search and printed statement.
- `sf_notify_submission()` triggers notify directors/controllers when a material PO or company
  expense enters `pending`, and when a site report is submitted. The notifier is exception-guarded
  so it can never roll back the business write; the app refreshes the bell right after submit.
- Site-report photo handling hardened: legacy inline photos survive edits, undecodable formats
  (iPhone HEIC) upload as-is, failed thumbnails show a placeholder, and a missing `photos` column
  produces a clear "run migration 202611031004" message.
- Migration `202611100001_expense_po_notifications.sql`.

Verified by `tools/checks/expenses-notifications.mjs` (15).

## 2. Audit backlog (still open)

Full tables: [`data-integrity.md`](audits/data-integrity.md) · [`ux-a11y.md`](audits/ux-a11y.md) ·
[`arch-perf.md`](audits/arch-perf.md). Line numbers there refer to the **pre-fix** baseline.

### Blockers that need your input / live project access

| # | Item | Why it needs you |
|---|---|---|
| A | **RLS as code + CI denial tests** (arch P0) | The committed anon key is public by design; authorization lives entirely in Postgres RLS, and nothing in-repo defines or tests it. `changeRole` also updates `profiles.role` from the browser — a self-promotion path if column-level RLS is absent. Needs database/schema access. |
| B | **Row-level scoping of `company_id`** (data #20) | Several loaders/inserts omit `company_id`; whether that leaks cross-company data depends on RLS. Unverifiable from source. |
| C | **`ev_pct`/`pv_pct` scale** (data #19) | Dashboard EV/PV math differs if those columns are 0–100 rather than 0–1. Needs the schema. |
| D | **Product direction** | Which matters more next: field-offline data (IndexedDB snapshot + write outbox), richer reports, or multi-project approvals? |

### High-value, no-input-needed

| Priority | Item | Effort |
|---|---|---|
| P1 | `fetchAllRows` returns `{rows,error}`; loaders keep prior state and show a retry banner instead of silently zeroing totals | M |
| P1 | Wire optimistic concurrency: keep `updated_at` in mappers, pass it from editors, `status='pending'` CAS on approvals | M |
| P1 | SRI hashes (or vendor) the CDN libraries; lazy-load SheetJS on first import/export (removes a 703 ms blocking request) | S–M |
| P1 | `fetchJson()` helper with `AbortController` timeouts for the 5 raw `fetch` sites (server OCR, admin ops) | S |
| P2 | Render only `#main`/`<tbody>` after mutations; debounce the two search inputs; page history/expenses (100 + "load more") | M |
| P2 | Company-level approvals queue from a cross-project `status='pending'` query; record approver per row | M |
| P2 | One print-window builder (5 duplicated document builders, popups never closed) | S–M |
| P2 | i18n: ~234 hardcoded English strings, 33 toasts, 18 `confirm()` prompts; locale-aware dates/currency (`Intl`) | L |
| P3 | Single version source (title/overlay `v28`, package `29.0.0`, CHANGELOG `29.0.0`); fill/drop CHANGELOG `[28.2]` placeholder | S |
| P3 | Move `apply_all.py` / `fix_anchors.py` to `tools/historical/` (or delete; git history is the archive) | S |

---

## 3. Recommended next phases

1. **Authorization you can prove** — RLS migrations + a CI job that signs in as anon/lead/super and asserts
   denials (`profiles`, `payroll_batches`, `company_budget_lines`, `profiles.role` self-update); route
   `changeRole` through the existing `adminOp` edge function. This is the only way the public anon key stops
   being a risk and becomes a documented property.
2. **Failure visibility** — `fetchAllRows` contract change + retry banner, `fetchJson` timeouts, offline state
   that disables submit instead of implying queued writes.
3. **Field-offline data** — IndexedDB snapshot of the current project for read-only offline viewing, then an
   outbox for writes with conflict reporting (uses the `updated_at` concurrency work).
4. **Rendering performance** — region/`<tbody>` re-render + search debounce + paging (measured: Compliance
   206 KB / 7,026 elements, Timesheets 134 KB / 4,816 per full rebuild).
5. **i18n completion** — LANG keys for the remaining literals, `Intl` formatting, `confirm()` → modal.

---

## 4. Verify

```bash
npm run serve             # http://127.0.0.1:8899
npm test                  # 51 app checks (PWA, a11y, helpers, offline, modules)
npm run test:views        # 31 authenticated view checks via mock Supabase (all roles)
npm run test:features     # 40 finance + 38 payment-request + 35 payslip + 28 independent math
npm run test:all          # everything above, in order
npm run smoke             # single load, fails on console errors / 4xx
npm run screenshots       # regenerate docs/screenshots/*.png
npm run icons             # regenerate icons/*.png from icons/icon.svg
```

HTML lint (as CI runs it): `npx --yes htmlhint@1 "index.html"`.

> Note: the audit reports were written against the pre-fix tree. They remain the backlog of
> record; line numbers drift after this branch, so match on function names, not line numbers.

## 5. Migrations to run (in filename order)

| File | Adds |
|---|---|
| `202611031001_payment_requests.sql` | `payment_requests` + RLS |
| `202611031002_finance_statements.sql` | `finance_settings` + RLS |
| `202611031003_payslips.sql` | `payslips` + RLS |
| `202611031004_po_approvals_and_site_photos.sql` | approver columns, `site_reports.photos` jsonb, `siteforge-files` bucket + storage policies |
| `202611041001_worker_links_and_payroll.sql` | `timesheets.worker_id` + payroll/receivables indexes (v29.3) |
| `202611050001_phase1_accountability.sql` | suppliers master, approval limits + events, server-side RPC approvals, RLS (v29.4) |
| `202611050002_phase2_workflow.sql` | evidence attachments, closed periods, approval SLA + escalation, goods received notes (v29.5) |

Run them in the Supabase SQL editor. Until then the three modules show a migration hint card and
the rest of the app is unaffected. RLS hardening (making the public anon key safe) is still the
top item in §2.
