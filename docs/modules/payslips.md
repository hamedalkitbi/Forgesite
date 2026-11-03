# Payslips module — printable payroll payslips (batch from approved timesheets)

Owner: payslips feature. Contract: [`CONTRACT.md`](CONTRACT.md).

- Module: [`scripts/modules/payslips.js`](../../scripts/modules/payslips.js) (one self-contained IIFE, no app.js edits)
- Migration: [`supabase/migrations/202611031003_payslips.sql`](../../supabase/migrations/202611031003_payslips.sql)
- Checks: [`tools/checks/payslips.mjs`](../../tools/checks/payslips.mjs) — `node tools/checks/payslips.mjs`
- View: `payslips` (sidebar → project section, icon 🧾), roles `director` / `controller` only.

The module turns **approved timesheets** for one project and one payroll period
(`YYYY-MM`) into a reviewable batch of payslips, saves them idempotently, tracks
their status (`draft → approved → paid`), and prints one payslip per A4 page —
single or the whole period in one document.

---

## 1. Install (one time)

Run the migration in the Supabase SQL editor (or `supabase db push`):

```
supabase/migrations/202611031003_payslips.sql
```

It is idempotent (`create table if not exists`, `create index if not exists`,
`create or replace function`, `drop policy if exists` before each `create policy`).
Until it is run, the Payslips view shows the migration filename plus the exact
PostgREST error instead of a blank page.

Rollback instructions are in the migration header. Do **not** drop
`public.sf_current_role()` — other module migrations share it.

---

## 2. Data model — `public.payslips`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `default gen_random_uuid()` |
| `project_id` | `uuid` not null | → `projects(id)` **on delete cascade** |
| `worker_id` | `uuid` | → `workers(id)` on delete set null; **null** when the timesheet name has no matching worker |
| `worker_name` | `text` not null | display name from the timesheet (source of truth for unmatched rows) |
| `staff_no` | `text` | from `workers.staff_no` when matched |
| `period` | `text` not null | `YYYY-MM`, checked with a regex |
| `days_worked` | `numeric(6,2)` | distinct timesheet dates in the period |
| `reg_hours`, `ot_hours` | `numeric(8,2)` | ≥ 0 |
| `hourly_rate_aed` | `numeric(10,2)` | weighted average timesheet rate for the period |
| `ot_rate_aed` | `numeric(10,2)` | `hourly_rate_aed × 1.5` |
| `gross_aed` | `numeric(14,2)` | regular + OT earnings |
| `loan_deduction_aed` | `numeric(14,2)` | capped at gross |
| `other_deductions_aed` | `numeric(14,2)` | ≥ 0 |
| `net_aed` | `numeric(14,2)` | ≥ 0 |
| `status` | `text` | `draft` (default) / `approved` / `paid` |
| `paid_at` | `timestamptz` | set when marked paid |
| `notes` | `text` | loan shortfall carried forward, warnings, generation period |
| `created_at` | `timestamptz` | `default now()` |

Keys:

- **`unique (project_id, worker_id, period)`** — the upsert conflict target
  (`onConflict: 'project_id,worker_id,period'`) that makes saving the same batch
  twice idempotent.
- Partial unique index `(project_id, period, lower(worker_name)) where worker_id is null`
  — because Postgres treats NULLs as distinct in a unique index, unmatched-name
  payslips need their own key to stay idempotent.

RLS: `select` for `authenticated`; `insert` / `update` / `delete` only when
`public.sf_current_role() in ('director','controller')` (the shared helper defined
by the module migrations).

---

## 3. Calculation rules (exact, source of truth)

All money is rounded to 2 decimal places with half-up rounding that tolerates
binary float error (`round2`). The same functions power the preview, the saved
rows, the checks and the printout:

```
otRate          = round2(hourly_rate × 1.5)
gross           = round2(reg_hours × hourly_rate + ot_hours × otRate)
loanDeduction   = round2(min(max(0, loan_balance), max(0, gross)))
otherDeductions = round2(max(0, input))
net             = max(0, round2(gross − loanDeduction − otherDeductions))
shortfall       = round2(max(0, loan_balance − loanDeduction))
```

- **`shortfall`** (loan balance that could not be recovered because it exceeds
  gross) is written into `notes` as
  `Loan shortfall: AED 400.00 carried forward to next period.` so the remainder is
  visible and can be picked up next period.
- **Negative inputs are clamped to 0 and reported**, never silently accepted:
  negative regular/OT hours, hourly rate, other deductions and loan balance each
  add a warning that is shown as a badge in the preview and stored in `notes`.
- The batch total row shows `days_worked`, `reg_hours`, `ot_hours`, `gross`,
  `loan_deduction`, `other_deductions` and `net` (all summed to 2dp).

Worked examples asserted by the checks:

| Input | Result |
|---|---|
| 8 h reg @ AED 25 + 2 h OT | OT rate 37.50 → gross **275.00** (200 + 75), net 275.00 |
| gross 100, loan balance 500 | loan deduction **100.00** (capped), net **0.00**, shortfall **400.00** in notes |
| 8 h reg @ 26.67 + 1 h OT | OT rate 40.01 → gross **253.37** |
| reg hours −8, OT hours −2 | both clamped to 0, gross 0, warning badge |

---

## 4. Generation flow

1. Pick the period (defaults to the current `YYYY-MM`).
2. **Generate from timesheets** groups the *approved* timesheets whose
   `work_date` falls in that period by employee name. Pending/rejected rows and
   other periods are excluded. Per name it sums regular/OT hours, counts distinct
   work days and computes a regular-hours-weighted hourly rate.
3. Each group is merged with `state.workers` (company-level):
   - exact name match first (case/whitespace-insensitive),
   - fallback to `staff_no` or `email` when the timesheet row carries one,
   - `staff_no`, `trade`, `nationality` come from the worker,
   - the outstanding **loan** comes from the packed worker notes.
   Worker pay is read defensively from `workers.notes`:
   - current format `<!--sfpay:{"salary":6500,"loan":4000,"deduct":800}-->\n<body>`,
   - legacy whole-notes JSON with `salary_aed` / `loan_balance` / `loan_deduction`
     (also accepts `salary` / `loan` / `deduct`),
   - plain-text notes, then raw `workers.salary_aed` / `loan_balance` /
     `loan_deduction` columns as a fallback.
   - If the timesheets carry no hourly rate but the worker has a monthly salary,
     the rate falls back to `salary ÷ 208 h` with a warning.
4. Names with **no matching worker** still appear in the preview with a warning
   badge and are saved with `worker_id = null` and `worker_name` only.
5. Every preview line is editable in place: days worked, regular hours, OT hours,
   hourly rate and other deductions. Gross / OT rate / loan / net / totals update
   live; negative input is reset to 0 and warned about.
6. **Save batch** upserts on `(project_id, worker_id, period)` — saving the same
   period again updates the existing payslips and preserves an already
   `approved`/`paid` status and `paid_at` (status is deliberately not part of the
   payload). Unmatched rows are reconciled by `worker_name` via
   select → update/insert because `onConflict` cannot target NULL `worker_id`.

`saveBatch(period, lines, projectId)` is exposed for the test suite and returns
`{saved, rows}`; it requires `SF.ui.canManage()`.

---

## 5. Saved list, status flow, print

- Saved payslips for the selected period render newest first with hours, gross,
  loan, other deductions, net, a status tag and the notes.
- Status flow (managers only): **draft → approved → paid**, with `paid_at`
  stamped on the paid transition. Delete is confirmed and uses `SF.db.remove`
  (audit + "affected 0 rows" protection from the app bridge).
- **Print** builds a standalone HTML document (no app shell) and opens it in a
  fresh window with `w.opener = null`, calls `w.print()` and closes the window on
  `afterprint` (plus a 60 s safety close). If the popup is blocked it falls back
  to a hidden iframe. The document includes:
  - company logo (`safeImgSrc(logo_data)`), name, address, phone/email and TRN,
  - worker name, staff no, nationality, trade, period, days worked,
  - an earnings table (regular hours × rate, OT hours × OT rate, gross total),
  - a deductions table (loan, other deductions) and the net payable row,
  - notes (including loan shortfall carried forward),
  - Employee / Prepared by / Approved by signature lines,
  - `dir="rtl"` + `lang="ar"` and Arabic labels when the app language is Arabic.
- Every payslip is one A4 page (`.slip { page-break-after: always }`, last slip
  auto). **Print all** emits every saved slip of the period in a single document.
- All dynamic values in print HTML and the view go through `SF.helpers.esc`;
  a worker named `<script>…` is rendered as text (asserted by the checks).

---

## 6. Test surface

```js
window.SF_modules.payslips = {
  computeLine, computeTotals, otRate, round2,      // pure calculation core
  parseWorkerPay, workerPayOf,                      // worker notes parsing
  buildLines,                                       // timesheets -> preview lines
  saveBatch, loadSaved, normalizeSaved, notesForLine,
  buildPrintHtml,                                   // print document (pure string)
  _setPeriod, _generate, _edit, _save, _action, _printOne, _printPeriod, _discard, _remove, _reload,
  _state, _reset                                    // diagnostics for the headless suite
};
```

Run the checks:

```bash
node tools/checks/payslips.mjs
```

They have three layers:

1. **Static** — module parses, migration idempotent + RLS + columns + constraints,
   view registration/roles, no raw `window.supabase` in the module, print CSS and
   `w.opener = null`, docs present.
2. **Pure (node:vm)** — OT ×1.5, gross/net rounding, loan cap at gross with
   shortfall in notes, clamping of negative/NaN hours, batch totals, worker-note
   parsing (packed/legacy/plain/raw columns), grouping + period filter + unmatched
   names, print pagination and HTML escaping (including a `<script>` worker name),
   and the missing-table migration hint.
3. **Headless (when `tools/lib/testkit.mjs` exists)** — boots the real app against
   the mock Supabase as `director`, opens the view, generates from seeded approved
   timesheets, saves twice for the same period (row count stays 3), walks
   draft → approved → paid (and confirms a re-save keeps `paid_at`), checks the
   print document, asserts zero JS exceptions, then verifies a `lead` cannot open
   the manager-only view. If the harness is not on disk yet the layer is skipped
   with a warning and the static/pure layers still run.

---

## 7. Assumptions & limitations

- Loan recovery per the feature spec is `min(loan_balance, gross)` — the full
  outstanding balance is recovered each period up to gross, with the remainder
  carried forward in `notes`. The worker's legacy monthly `loan_deduction` hint is
  parsed and shown in the Workers view but is not applied as a monthly cap by this
  module.
- `days_worked` counts distinct timesheet dates, not a separate attendance source.
- Mixed hourly rates inside one period are averaged (weighted by regular hours)
  and flagged with a warning instead of being rejected.
- `worker_name` is the join key for unmatched rows; renaming a worker between
  saves creates a new payslip rather than stealing the old one.
- Payroll batches (`payroll_batches`) remain the certification record; payslips do
  not write to it.
- The print window relies on the browser's print dialog; "PDF" is the browser's
  save-as-PDF, exactly like the app's other print documents.
