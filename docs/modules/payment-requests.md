# Module: Payment Requests (subcontractors & suppliers)

Project-level **payment requests** with a submit → approve/reject → pay workflow,
retention and advance recovery, ageing, printable documents and a full audit
trail. The feature is self-contained: it registers the `payment-requests` view
through the `window.SF` bridge and never edits `scripts/app.js`.

| Artifact | Path |
|---|---|
| Module (view + logic) | `scripts/modules/payment-requests.js` |
| Migration (table, RLS, trigger) | `supabase/migrations/202611031001_payment_requests.sql` |
| Checks | `tools/checks/payment-requests.mjs` |
| This document | `docs/modules/payment-requests.md` |

Read `docs/modules/CONTRACT.md` first — this module follows that contract
(classic script, IIFE, `'use strict'`, registration via `SF.registerView`,
missing-table degradation, migration conventions, EN/AR).

---

## 1. Install / upgrade

Run the migration **once** in the Supabase SQL editor (or `supabase db push`).
It is idempotent: re-running it is safe.

```sql
-- paste supabase/migrations/202611031001_payment_requests.sql into the SQL editor
```

Until the migration has run, the view renders a "Database update required"
card that names the migration file and prints the PostgREST error text — it never
renders a blank table or throws.

Rollback (manual):

```sql
drop policy if exists payment_requests_select on public.payment_requests;
drop policy if exists payment_requests_insert on public.payment_requests;
drop policy if exists payment_requests_update on public.payment_requests;
drop policy if exists payment_requests_delete on public.payment_requests;
drop trigger if exists trg_payment_requests_compute_amounts on public.payment_requests;
drop function if exists public.payment_requests_compute_amounts();
drop table if exists public.payment_requests;
-- public.sf_current_role() is shared with the other module migrations — keep it.
```

---

## 2. Data model

`public.payment_requests` (project-scoped, `on delete cascade` from `projects`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `default gen_random_uuid()` |
| `project_id` | uuid | `references projects(id) on delete cascade`, not null |
| `party_id` | uuid | `references project_parties(id) on delete set null` (subcontractor/supplier) |
| `request_type` | text | `check in ('subcontractor','supplier')` |
| `reference` | text | `PR-001`, **unique per project** (`unique (project_id, reference)`) |
| `description` | text | works / supply description |
| `amount_aed` | numeric(14,2) | `check > 0` (certified gross amount) |
| `retention_pct` | numeric(5,2) | `default 0`, `0…100` |
| `retention_aed` | numeric(14,2) | computed, `>= 0` |
| `advance_recovery_aed` | numeric(14,2) | `default 0`, `>= 0` |
| `net_aed` | numeric(14,2) | computed, `>= 0` |
| `due_date` | date | drives overdue / ageing; nullable |
| `status` | text | `check in ('draft','submitted','approved','rejected','paid')`, default `draft` |
| `requested_by` | text | `profiles.name` of the raiser / submitter |
| `approved_by` | text | `profiles.name` of the approving director/controller |
| `approved_at` | timestamptz | set together with `approved_by` |
| `rejected_reason` | text | **mandatory** when status becomes `rejected` |
| `paid_at` | timestamptz | set when status becomes `paid` |
| `payment_method` | text | set with `paid_at` |
| `notes` | text | free text |
| `created_at` | timestamptz | `default now()` |

`advance_recovery_aed` is required by the net-payable formula in the feature
spec (which names the deduction but omits the column); it is added explicitly.
The spec allows `retention_aed`/`net_aed` to be "generated-or-computed" — they
are stored plain columns that the client computes before writing, and a
`BEFORE INSERT OR UPDATE OF amount_aed, retention_pct, advance_recovery_aed`
trigger re-derives them server-side (and raises `23514` if `net_aed < 0`), so
direct PostgREST writes cannot store inconsistent arithmetic.

### RLS policies

| Operation | Policy |
|---|---|
| `select` | any `authenticated` user |
| `insert` | `public.sf_current_role() in ('director','controller','super')` |
| `update` | `using` + `with check` for the same three roles |
| `delete` | same three roles |

`sf_current_role()` is the shared helper from the contract (`create or replace`,
`security definer`, `set search_path = public`). The UI hides
approve/reject/pay/edit/delete from non-managers (`SF.ui.canManage()` is
director/controller only); `super` can raise and submit requests but never
approve. The database policy intentionally also allows `super` writes so a
superintendent can raise/resubmit; narrowing the UI is the guard for the
manager-only actions.

---

## 3. Workflow

```
draft ──submit──► submitted ──approve──► approved ──mark paid──► paid
  ▲                   │
  │                   └──reject (reason required)──► rejected ──resubmit──► submitted
  └────────────────────────── edit (draft / rejected / submitted) ◄──────────┘
```

| Transition | Who (UI) | Payload written | Audit |
|---|---|---|---|
| create | any view role | row with status `draft` or `submitted`, `requested_by` = current user | `db.log('create','payment_requests',…)` |
| submit / resubmit | any view role | `status='submitted'`, clears `rejected_reason`, fills `requested_by` if empty | `db.log('update',…)` |
| approve | `canManage()` | `status='approved'`, `approved_by=SF.user.name`, `approved_at=now` | `db.log('update',…)` |
| reject | `canManage()` | `status='rejected'`, `rejected_reason=<modal reason>` — an empty reason is blocked in the modal | `db.log('update',…)` including the reason |
| mark paid | `canManage()` | `status='paid'`, `payment_method`, `paid_at` (date → `YYYY-MM-DDT12:00:00.000Z` for timezone-stable display) | `db.log('update',…)` |
| edit | `canManage()` | fields + recomputed retention/net; blocked for `approved`/`paid` | `db.log('update',…)` |
| delete | `canManage()` | confirm → delete | `db.log('delete',…)` |
| print | any view role | opens a standalone document window (`w.opener=null`, prints, then `w.close()`) | — |

Every state change also shows an `SF.ui.toast` and re-fetches the table. The
`SF.db.insert/update/remove` bridge already writes `transaction_history`; the
module adds an explicit `SF.db.log(...)` entry with a human label
(`PR-001 · approved`) so the audit trail leads with the request reference.

---

## 4. Calculation rules (exact to 2dp)

```
retention_aed = round(amount_aed × retention_pct / 100, 2)
net_aed       = round(amount_aed − retention_aed − advance_recovery_aed, 2)
```

- Rounding is **half away from zero at 2 decimals** (`round2`). Monetary values
  are positive in this feature, so this matches SQL `round(numeric, 2)` and
  `Math.round` semantics: `1000 @ 2.5% → 25.00`; `333.33 @ 7.5% → 25.00`.
- `net_aed < 0` is a **validation error**, never silently clamped to zero:
  `validate()` returns `ok:false` with an error naming retention, advance
  recovery and amount; the form keeps the modal open and shows the message.
  `net_aed === 0` is allowed (retention + recovery exactly exhaust the amount).
- The UI persists the rounded values it displayed (`computeTotals`), so the row,
  the KPI sums and the printed document all agree to the fils.

### Reference sequencing

`reference = 'PR-' || lpad(sequence, 3, '0')`, starting `PR-001` per project.

- `nextReference(existing)` parses the **trailing digits** of every existing
  reference (strings or rows; `PR-009` → 9, `PR-100` → 100; unrelated values
  with no trailing digits are ignored), takes `max + 1`, and zero-pads to at
  least 3 digits (`PR-1000` is valid once the sequence passes 999).
- The client derives the next reference at form-open time and validates it
  against the loaded rows, then re-checks it against unique violations on
  insert: if Postgres reports a duplicate (`23505` / unique constraint), the
  module bumps the number and retries up to 5 times. Two users creating at the
  same time therefore cannot persist the same reference.
- Editing lets a manager keep or change the reference, but a duplicate is a
  validation error before the write.

### Overdue / ageing

```
overdue = due_date < today AND status NOT IN ('paid','rejected')
```

Ageing buckets are measured in whole days past due (UTC date math, no timezone
drift), inclusive upper bounds:

| Bucket | Days past due |
|---|---|
| `not_due` | not due yet (or due today) |
| `1-30` | 1 … 30 |
| `31-60` | 31 … 60 |
| `61-90` | 61 … 90 |
| `90+` | 91 or more |
| `closed` | status `paid` or `rejected` (never overdue) |
| `no_due` | no `due_date` on the row |

`computeAgeing(row, today)` returns `{bucket, overdue, daysOverdue, daysUntilDue,
closed}`; `ageingSummary(rows, today)` aggregates count + net value per bucket
(the view shows this as the ageing card).

---

## 5. UI

The view is registered as `payment-requests` (nav section **project**, icon 🧾,
roles `director`, `controller`, `super`).

- **Header** — title, subtitle, project name/code, `+ New Request`.
- **KPI cards** — pending (submitted) count + net value, approved-unpaid value,
  overdue count + value, paid-to-date value.
- **Ageing card** — count + net value per ageing bucket.
- **Filters** — type (all/subcontractor/supplier), status (all + five statuses),
  free-text search over reference, party, description, requester, notes.
- **Table** — ref, type tag, party (name + company), description, gross amount,
  retention (with % and advance recovery), net payable, due date with
  overdue/due-soon tag, status (approver, rejection reason or paid method shown
  underneath), and per-row actions: submit, approve, reject, mark paid, print,
  edit, delete. Actions are rendered per status and per permission; `super` sees
  submit/print only, managers also see approve/reject/pay/edit/delete.
- **Create/edit form** — `SF.ui.openFormModal`; party dropdown is built from
  `SF.parties` filtered to subcontractors/suppliers and re-filtered live when the
  request type changes; reference, type, party, description, amount, retention %,
  advance recovery, due date and notes. Validation (required fields, amount > 0,
  retention 0–100, net ≥ 0, unique reference) runs before the write and is shown
  in the form error region.
- **Loading / empty / error** — a spinner card first (no blank flash), a friendly
  empty state, and the migration-hint card (file name + PostgREST message) when
  `SF.db.selectStrict` errors.
- **i18n** — every label comes from the module `L` object (EN + AR), including
  the print document, which sets `<html dir>` and start/end alignment from
  `SF.language`.

### Print document

`buildPrintHtml(row, ctx)` returns a complete standalone HTML document:

- company branding from `SF.company` (name, address, `tax_id`, phone and logo via
  `SF.helpers.safeImgSrc`; unsafe/malicious logo URLs are dropped),
- project info (name/code/location/plot/client),
- party details (name, company, party type, contact/phone/email/address),
- amount / retention / advance recovery / net payable breakdown,
- request number, dates, status, requested-by, approved-by/at, payment method,
  notes,
- three signature lines (requested / approved / received),
- `dir` and alignment aware for Arabic.

All dynamic values pass through `SF.helpers.esc` (falling back to an identical
local escaper when the bridge is unavailable), so a party name containing
`<script>` is rendered inert. `printRequest()` opens the document with
`window.open('', '_blank')`, sets `w.opener = null`, writes the HTML, prints, and
closes the window on a `setTimeout` after printing; if the popup is blocked it
shows a toast instead of failing silently.

---

## 6. Test surface

`window.SF_modules['payment-requests']` exposes the pure helpers:

| Function | Purpose |
|---|---|
| `computeRetention(amountAed, retentionPct)` | 2dp retention; also accepts `{amount_aed, retention_pct}` |
| `computeNet(amountAed, retentionAed, advanceRecoveryAed)` | 2dp net; also accepts objects with `amount_aed`/`retention_pct`/`retention_aed`/`advance_recovery_aed` |
| `computeAgeing(row, today?)` | `{bucket, overdue, daysOverdue, daysUntilDue, closed}` |
| `nextReference(existingRefs, pad?)` | next `PR-NNN` from trailing digits |
| `validate(input, ctx)` | `{ok, errors, values}`; rejects negative net and duplicate references |
| `computeTotals(input)` | `{amount_aed, retention_pct, retention_aed, advance_recovery_aed, net_aed}` |
| `ageingSummary(rows, today?)` | per-bucket counts/values + overdue totals |
| `buildPrintHtml(row, ctx)` | printable document HTML (escaped, dir-aware) |
| `round2(n)` | the 2dp rounding primitive |

The helpers are defined before the `window.SF` guard, so a Node harness can
evaluate the module with a bare `window` object and unit-test the math even when
the app/testkit is not loaded.

`tools/checks/payment-requests.mjs` is dependency-free (`node
tools/checks/payment-requests.mjs`) and covers:

1. static checks — module parses (`node --check`), view registration, migration
   existence + idempotency + required columns/checks/RLS, docs presence;
2. pure math — retention/net rounding edge cases, negative-net validation,
   reference sequencing, ageing bucket boundaries, print escaping (`<script>` in
   a party name, unsafe logo);
3. when `tools/lib/testkit.mjs` is on disk, headless integration — director
   sees approve buttons and super does not, the view renders with seeded
   fixtures for both roles, and the console has zero errors.

---

## 7. Assumptions / decisions

- `advance_recovery_aed` is stored on the request (spec formula requires it).
- `retention_aed`/`net_aed` are plain columns plus a server trigger rather than
  `GENERATED` columns: the client must validate and display them before the row
  exists, and the module has to work against the mock PostgREST in tests.
- `status` deliberately uses the spec vocabulary (`draft`, `submitted`,
  `approved`, `rejected`, `paid`). The mock harness's legacy `payment_requests`
  fixtures use `pending`/`request_no`; the module normalizes unknown statuses to
  `draft` and falls back to computed amounts, so a legacy row still renders.
- "Paid" writes `paid_at` at 12:00 UTC on the chosen date so the printed date
  does not shift across timezones; `fmtDate` renders the calendar date.
- Edit is intentionally limited to `draft`/`rejected`/`submitted`; `approved`
  and `paid` requests are immutable except for deletion (manager only), which
  keeps the certification trail honest.
- The migration's write policies include `super` (per spec) while the UI hides
  manager-only actions; this is documented above.
- `sf_current_role()` is redefined with `create or replace` in this migration,
  matching the other module migrations in this branch.
