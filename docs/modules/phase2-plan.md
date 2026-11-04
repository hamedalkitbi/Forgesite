# Phase 2 — evidence, period close, SLA escalation, 3-way match

Authoritative contract. Owners per file; do not edit another owner's files. Spec mirrors Phase 1 patterns.

## DB (owner: db-engineer2 — `supabase/migrations/202611050002_phase2_workflow.sql`)

Idempotent, end with `notify pgrst, 'reload schema';`.

### New tables
```sql
public.approval_attachments (
  id uuid pk default gen_random_uuid(),
  table_name text not null,     -- materials / change_orders / company_expenses / payment_requests / timesheets
  record_id uuid not null,
  file_path text not null, file_name text not null,
  file_size bigint, mime_type text, uploaded_by text,
  created_at timestamptz default now()
);

public.approval_attachment_rules (
  id uuid pk default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  table_name text not null,
  min_amount_aed numeric(14,2) not null default 0,   -- 0 = evidence never required
  unique (company_id, table_name)
);
-- seed (per company, on conflict do nothing): materials 25000, change_orders 10000,
-- payment_requests 50000, company_expenses 5000, timesheets 0.

public.closed_periods (
  id uuid pk default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  period text not null,          -- 'YYYY-MM'
  closed_at timestamptz default now(), closed_by text, reason text,
  unique (company_id, period)
);

public.approval_sla (
  id uuid pk default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  sla_days int not null default 3,
  escalate_to text,              -- role or email; informational
  updated_at timestamptz default now()
);

public.goods_received_notes (
  id uuid pk default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  material_id uuid references public.materials(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  reference text not null,       -- GRN-0001 (unique per project)
  received_date date not null,
  qty_received numeric(14,2) not null check (qty_received >= 0),
  received_by text, notes text, status text default 'received',
  created_at timestamptz default now()
);
```

### Functions / RPCs
```sql
public.sf_assert_period_open(p_company uuid, p_date date) returns void
  -- raises 'CLOSED_PERIOD' if to_char(p_date,'YYYY-MM') in closed_periods for p_company.
public.sf_guard_closed_period() returns trigger
  -- BEFORE INSERT OR UPDATE on the dated tables; maps TG_TABLE_NAME to its date column:
  -- timesheets->work_date, company_expenses->expense_date, payments->paid_date (fallback due_date),
  -- payroll_batches->period (YYYY-MM), progress_billings->period_from, materials->invoice_date.
  -- Uses sf_assert_period_open (company resolved via project_id/company_id). Raises exception.
public.sf_material_grn(m_id uuid) returns jsonb
  -- {"received_qty":..., "matched":bool}  (sum qty_received over goods_received_notes where material_id)
public.sf_escalate_overdue() returns void
  -- for pending records older than (select sla_days from approval_sla) days, insert a
  -- notifications row (user_id = profiles of directors/controllers, type 'escalation',
  -- title 'Approval overdue', body with record/amount/age) — dedupe by (record) via a
  -- notif_dedupe text column if present, else best-effort.
```
A `pg_cron` schedule is OPTIONAL (guarded with a comment + `select cron.schedule(...)` only if
`(select count(*) from pg_extension where extname='pg_cron')=1`). The app also calls
`sf_escalate_overdue()` opportunistically after login.

### Triggers
Attach `sf_guard_closed_period()` to timesheets, company_expenses, payments, payroll_batches,
progress_billings, materials (BEFORE INSERT OR UPDATE). Do NOT touch profiles/projects/companies.

### RLS
- approval_attachments: select authenticated; insert authenticated; delete director/controller OR uploaded_by = sf_current_user().
- approval_attachment_rules: select authenticated; write director.
- closed_periods: select authenticated; write director.
- approval_sla: select authenticated; write director.
- goods_received_notes: select authenticated; insert director/controller/super; update/delete director/controller.

## App integration (owner: Lead — app.js, index.html)

Bridge additions:
- `SF.attachments = { list(table,id), upload(table,id,file), remove(id), requiredFor(table,amount) }`
- `SF.periods = { list(), isClosed(period), close(period,reason), reopen(period) }`
- `SF.grn = { receivedQty(materialId), forMaterial(materialId), add(...) }`
- `SF.sla = { get() }`

Behaviours:
- **Evidence**: attach file(s) on PO / change order / expense / payment-request submit. If the
  amount >= `approval_attachment_rules.min_amount_aed` and no attachment exists, block submit
  with a clear message. Show a 📎 + count in the approvals queue and a "required/attached" badge.
- **Period close**: `insertRow`/`updateRow` call `SF.periods` guard (app-level, mirrors the DB
  trigger) and surface the denial. Settings gains a "Closed periods" section (director): list,
  close current/prior month with reason, reopen. Finance/payroll/payments views show a 🔒 badge
  when the selected period is closed and disable edit buttons.
- **SLA**: Settings "Approval SLA" (days) read/write approval_sla; approvals queue adds an
  "Overdue" filter + escalates via `sf_escalate_overdue` after login; notifications panel shows
  escalation items.
- **3-way match**: a PO must have a GRN (received qty >= ordered qty, or an explicit "received in
  full" quick-GRN) before `convertPOToBill`; marking a supplier payment `paid` checks the matched
  material/GRN and warns/blocks if unmatched. Materials rows link to their GRNs.

## GRN module (owner: grn-module — scripts/modules/grn.js, docs/modules/grn.md, tools/checks/grn.mjs)
Company+project view "Receiving (GRN)": list GRNs for the project, add GRN against an approved PO
(material select), show received vs ordered qty + match status, expose `window.SF_modules.grn`.
Registers `nav:{section:'project', icon:'📦', label:'Receiving / GRN', labelAr:'استلام البضاعة'},
roles:['director','controller','super']`.

## Tests (owner: verifier2 — tools/lib/mock-supabase.mjs additions + tools/checks/phase2.mjs)
Mirror approval_attachments/approval_attachment_rules/closed_periods/approval_sla/goods_received_notes
and the functions in the mock; add `sf_assert_period_open` + `sf_material_grn` + `sf_escalate_overdue`.
phase2.mjs asserts: required-evidence gate blocks submit over threshold; attachment list/delete;
period close blocks a dated write and reopen allows; escalation inserts a notification for an old
pending record; GRN received-qty math + match status; PO billing blocked without GRN; supplier
payment blocked without GRN; static idempotency/RLS greps.
