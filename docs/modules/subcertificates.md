# Subcontractor Measurement & Certificates module

Owner: modules3. Contract: [`CONTRACT.md`](CONTRACT.md).

- Module: [`scripts/modules/subcertificates.js`](../../scripts/modules/subcertificates.js) (one self-contained IIFE, no `app.js` edits)
- Migration: [`supabase/migrations/202611050003_phase3.sql`](../../supabase/migrations/202611050003_phase3.sql) (owned by db-engineer; also creates `retention_releases` + `sf_retention_open` RPC)
- Checks: [`tools/checks/subcertificates.mjs`](../../tools/checks/subcertificates.mjs) — `node tools/checks/subcertificates.mjs`
- View: `subcertificates` (sidebar → **project** section, icon 📏), roles `director` / `controller`.

Measure subcontractor work against a BOQ line and a supplier/subcontractor,
producing a `SC-####` certificate whose certified amount is
`measured_qty × rate_aed` (rounded to 2 dp). A **Project Director** certifies a
draft; any manager can then "Generate payment request", which inserts a
`public.payment_requests` row so the certificate flows through the Executive
Approvals Queue.

---

## 1. Install (one time)

```
supabase/migrations/202611050003_phase3.sql
```

Until it is run, the view shows the migration filename plus the exact PostgREST
error. Rollback instructions are in the migration header.

---

## 2. Data model

### `public.subcontractor_certificates`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `default gen_random_uuid()` |
| `project_id` | `uuid` | → `projects(id)` **on delete cascade** |
| `supplier_id` | `uuid` | → `suppliers(id)` **on delete set null** |
| `boq_item_id` | `text` | `boq_items.id` may be text in this deployment |
| `reference` | `text` not null | `SC-0001` per project (app-enforced uniqueness) |
| `period` | `text` | `'YYYY-MM'` |
| `measured_qty` | `numeric(14,2)` not null | `check (measured_qty >= 0)` |
| `rate_aed` | `numeric(14,2)` not null | |
| `certified_amount_aed` | `numeric(14,2)` not null | `qty × rate` (module-computed) |
| `status` | `text` not null | `check (status in ('draft','certified','paid'))`, default `draft` |
| `certified_by` | `text` | director name |
| `certified_at` | `timestamptz` | |
| `payment_request_id` | `text` | linked `payment_requests.id` |
| `notes` | `text` | |
| `created_at` | `timestamptz` | `default now()` |

RLS (per the phase-3 plan): `select` authenticated; `insert`/`update`/`delete`
director/controller.

---

## 3. Behaviour

- **List** — auto-generated reference `SC-0001…` (highest trailing number + 1,
  width 4), BOQ line label (`code · description`), subcontractor name, qty, rate,
  certified amount, status tag, and the linked payment-request id when present.
- **Create** — `SF.ui.openFormModal`: BOQ line (select from `SF.data.state.boq`),
  supplier (select from `SF.data.state.suppliers`, falling back to
  `SF.suppliers.list()` / `SF_modules.suppliers.list()`), `measured_qty`,
  `rate_aed`, notes. `certified_amount_aed` is always recomputed from
  `qty × rate` (round 2). Validates `qty > 0`, `rate > 0`, BOQ + supplier chosen.
- **Certify** (Director only) — sets `status='certified'`, `certified_by`,
  `certified_at` via `SF.db.update`.
- **Generate payment request** — inserts `public.payment_requests` with
  `{ project_id, party_id: null, request_type: 'subcontractor',
  reference: 'PR-' + certificateRef, description: 'Subcontractor certificate ' + certificateRef,
  amount_aed: certified, retention_pct: 0, retention_aed: 0, net_aed: certified,
  due_date: today + 30d, status: 'submitted', requested_by: SF.user.name }`, then
  stores the inserted id back on the certificate `payment_request_id`. Requires a
  `certified` certificate without an existing link.

---

## 4. Public API — `window.SF_modules.subcertificates`

| Member | Signature | Returns |
|---|---|---|
| `list` | `list()` | array of cached certificate rows (copy) |
| `compute` | `compute(qty, rate)` | `number` — `round2(qty × rate)` |
| `nextReference` | `nextReference(rows, width?)` | `string` — next `SC-####` |
| `create` | `create(values)` | `Promise<{ ok, row | error }>` |
| `certify` | `certify(certId)` | `Promise<{ ok | error }>` (Director only) |
| `generatePaymentRequest` | `generatePaymentRequest(certId)` | `Promise<{ ok, paymentRequest | error }>` |

All promises are defensive and never reject.

---

## 5. i18n

EN + AR via a local `L` dictionary with English fallback; the active language is
read from `SF.language`. All labels are escaped with `SF.helpers.esc`.

---

## 6. Testing

`node tools/checks/subcertificates.mjs` runs:

1. **Static** — `node --check`; greps for the view registration (id
   `subcertificates`, project nav, 📏 icon, `director`/`controller` roles), the
   public API keys, `selectStrict('subcontractor_certificates', …)`,
   `payment_requests` + `status: 'submitted'` + `request_type: 'subcontractor'`
   wiring, and SQL-idempotency greps of the phase-3 migration for
   `subcontractor_certificates` (skipped with a note if the file is not on disk).
2. **Testkit** — once `tools/lib/mock-supabase.mjs` mirrors
   `subcontractor_certificates`, it boots the real app headless and asserts: the
   view renders, `compute`/`nextReference` math, `create` → `certify` →
   `generatePaymentRequest` linking (certificate `payment_request_id` matches the
   inserted `payment_requests.id`). If the mock lacks the table, the testkit step
   prints `skipped (mock not ready)` and exits 0.
