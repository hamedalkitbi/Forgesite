# Management Exceptions module — company-level dashboard

Owner: modules3. Contract: [`CONTRACT.md`](CONTRACT.md).

- Module: [`scripts/modules/management.js`](../../scripts/modules/management.js) (one self-contained IIFE, no `app.js` edits)
- Migration: [`supabase/migrations/202611050003_phase3.sql`](../../supabase/migrations/202611050003_phase3.sql) (owned by db-engineer; supplies `retention_releases`)
- Checks: [`tools/checks/management.mjs`](../../tools/checks/management.mjs) — `node tools/checks/management.mjs`
- View: `management` (sidebar → **company** section, icon 📊), roles `director` / `controller`.

A company-wide "management by exception" dashboard. It aggregates **across all
projects** (no project filter, like the finance module) and surfaces five risk
indicators, each as a KPI card plus a detail list.

---

## 1. Metrics

| Metric | Source | Calculation |
|---|---|---|
| **Overdue approvals** | pending approval items | items older than the approval SLA (`SF.sla.days()`, default 3) — count + total amount |
| **Unlinked material cost** | `materials` (cross-project) | rows with no `boq_item_id` — `Σ qty × unit_cost_aed` |
| **Duplicate supplier invoices** | `payments` (cross-project) | `invoice_no` values appearing more than once — count + total amount |
| **Committed · undelivered POs** | `materials` (cross-project) | rows in stage `Ordered` / `In Transit` — `Σ qty × unit_cost_aed` |
| **Open retention** | `progress_billings` + `retention_releases` | `Σ certified/paid retention_amount − Σ released amount_aed` (per project + total) |

Pending approval items are read through `window.__sf.collectPendingItems('all')`
when the selftest bridge is present, otherwise reconstructed from
`SF.data.state` (boq / timesheets / expenses / materials / change-orders and the
cross-project `globalPending` buckets). Overdue age is computed from each item's
`createdAt` with `daysSince`.

---

## 2. Data loading

`materials`, `payments` and `progress_billings` are the core tables and are
loaded cross-project with `SF.db.selectStrict(name, null, null, false)` (raw rows
are normalised to the same camelCase shape `app.js` maps into
`SF.data.state`). `retention_releases` is optional: if it is missing the module
treats released as zero and shows a small migration note, keeping the other four
metrics intact. A missing **core** table renders the generic error card.

---

## 3. Public API — `window.SF_modules.management`

Pure functions take data as arguments so the Node checks can assert on fixtures
without the DOM.

| Member | Signature | Returns |
|---|---|---|
| `unlinkedMaterialCost` | `(materials)` | `{ count, value, rows }` |
| `duplicateSupplierInvoices` | `(payments)` | `{ count, value, rows }` |
| `committedUndeliveredPos` | `(materials)` | `{ count, value, rows }` |
| `openRetentionTotal` | `(billings, releases)` | `{ totalRetained, released, open, breakdown }` |
| `overdueApprovals` | `(items, slaDays, todayValue?)` | `{ count, value, rows }` |
| `pendingItems` | `()` | array of pending approval items |
| `metrics` | `()` | all five metrics computed from the current cache |
| `refresh` | `()` | re-render + reload |

---

## 4. i18n

EN + AR via a local `L` dictionary with English fallback; the active language is
read from `SF.language`. All labels are escaped with `SF.helpers.esc`.

---

## 5. Testing

`node tools/checks/management.mjs` runs:

1. **Static** — `node --check`; greps for the view registration (id `management`,
   company nav, 📊 icon, `director`/`controller` roles), the public API keys,
   `selectStrict` cross-project loading, `collectPendingItems`/`daysSince` usage
   and `retention_releases`; SQL-idempotency greps of the phase-3 migration for
   `retention_releases` (skipped with a note if the file is not on disk).
2. **Testkit** — once the mock mirrors the core tables (it already seeds
   `materials` / `payments` / `progress_billings`), it boots the real app headless
   and asserts: the view renders with zero exceptions, and the pure metric
   functions return the correct counts/values on seeded fixtures (unlinked
   material cost, committed POs, open retention with `released = 0`). If the
   required tables are absent, the testkit step prints `skipped (mock not ready)`.
