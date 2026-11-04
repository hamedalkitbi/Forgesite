# Phase 1 — accountability + global supplier/contractor master

Authoritative contract for the team. Owners are listed per file; **do not edit another owner's files**.

## Goals

1. Authority moves server-side (RLS + RPC), with segregation of duties and limits of authority.
2. An immutable `approval_events` log gives a defensible timeline.
3. A company-wide supplier/contractor directory, reused across projects, parties, POs and payment requests.
4. Approvals UI gets an inbox (All / For me / By me) with age colouring and a per-record timeline.

## Database (owner: db-engineer — `supabase/migrations/20261105*.sql`)

Create, in **one** idempotent migration file `202611050001_phase1_accountability.sql`:

### New tables
```sql
public.suppliers (company-level master)
  id uuid pk default gen_random_uuid()
  company_id uuid references public.companies(id) on delete cascade
  name text not null
  kind text not null check (kind in ('supplier','subcontractor','both'))
  trade text, trn text
  contact_person text, phone text, email text, address text
  bank_name text, iban text, account_no text
  payment_terms_days int default 30
  vat_pct numeric(5,2) default 5
  status text not null default 'active' check (status in ('active','inactive','blocked'))
  created_by text, created_at timestamptz default now(), updated_at timestamptz default now()

public.project_suppliers (link master -> project)
  project_id uuid references public.projects(id) on delete cascade
  supplier_id uuid references public.suppliers(id) on delete cascade
  contract_amount_aed numeric(14,2), reference text, notes text
  primary key (project_id, supplier_id)

public.approval_limits (limits of authority)
  id uuid pk default gen_random_uuid()
  company_id uuid references public.companies(id) on delete cascade
  role text not null                       -- director / controller / super
  table_name text not null                 -- materials, change_orders, payment_requests, company_expenses, timesheets, boq_items
  max_amount_aed numeric(14,2) not null    -- 0 = may not approve this (table, role)
  unique (company_id, role, table_name)

public.approval_events (append-only; no update/delete policy for anyone)
  id bigint generated always as identity primary key
  company_id uuid, project_id uuid
  table_name text not null, record_id uuid not null
  action text not null                    -- submit / approve / reject / pay / certify / resubmit
  from_status text, to_status text
  amount_aed numeric(14,2)
  actor_id uuid, actor_name text, actor_role text
  reason text
  before_data jsonb, after_data jsonb
  created_at timestamptz default now()
```

### Column additions (for SoD the actor must differ from the creator)
```sql
alter table public.materials        add column if not exists created_by text;
alter table public.boq_items        add column if not exists created_by text;
alter table public.change_orders    add column if not exists created_by text;
alter table public.timesheets       add column if not exists created_by text;
alter table public.company_expenses add column if not exists created_by text;
-- payment_requests already has requested_by; use it as the creator column.
-- backfill existing rows' created_by = '—' (unknown) so SoD never blocks history.
```

### Server-side role + actor helpers (create or replace)
```sql
public.sf_current_role()  returns text  -- select role from profiles where id = auth.uid()
public.sf_current_user()  returns text  -- select name  from profiles where id = auth.uid()
```

### RPCs (security definer, search_path = public)
```sql
public.sf_approve_record(p_table text, p_id uuid, p_reason text default null)
  returns jsonb  -- {"ok":true,"message":...,"status":"approved"} or {"ok":false,...}
public.sf_reject_record(p_table text, p_id uuid, p_reason text)  -- reason required
```
Both must, in order:
1. role = sf_current_role(); allow only director/controller (deny otherwise).
2. Resolve the record + amount per table:
   materials: quantity*unit_cost_aed · boq_items: quantity*rate · change_orders: amount
   timesheets: total_cost_aed · company_expenses: amount · payment_requests: net_aed
3. **Limits**: director is unlimited; controller/super require an `approval_limits` row for
   (company_id of the record, role, table_name) with max_amount_aed >= amount. No row = deny
   (fail closed). Log "over limit" and stop.
4. **SoD**: creator = `created_by` (or `requested_by` for payment_requests); if creator equals
   sf_current_user(), deny "you cannot approve your own submission".
5. CAS update `... where id = p_id and status = 'pending'` (payment_requests use 'submitted')
   set status='approved'/'rejected', approved_by=sf_current_user(), approved_at=now(),
   rejection_reason=reason (reject only). 0 rows → already decided → deny.
6. Insert an `approval_events` row (action approve/reject, from→to status, amount, actor,
   reason, before/after minimal jsonb).

`payment_requests` has a pending status of `'submitted'` — handle that table explicitly.

### RLS
- `approval_events`: select to authenticated; **no** insert/update/delete (inserts happen only
  via the security-definer RPCs). 
- `suppliers`: select authenticated; insert/update/delete director/controller.
- `project_suppliers`: select authenticated; write director/controller/super.
- `approval_limits`: select authenticated; write director only.
- Operational approval tables (`materials`, `boq_items`, `change_orders`, `timesheets`,
  `company_expenses`, `payment_requests`): enable RLS if not enabled; policies:
  - select to authenticated
  - insert to authenticated
  - update/delete: director/controller OR (row created_by = sf_current_user())
  - **direct status writes are NOT blocked by RLS** (a manager could bypass the RPC), so the
    RPC is the enforcement point for SoD/limits; RLS here stops casual cross-user tampering.
- Do **not** touch `profiles`, `projects`, `companies`, `payments`, `payroll_batches`, or any
  table not listed above — those are out of scope for Phase 1 (note this in the file header).

Every statement idempotent. End with `notify pgrst, 'reload schema';`.

## Bridge additions needed from app.js (owner: Lead)

- `SF.db.rpc(name, args)` → `supabase.rpc(name, args)` (returns `{data,error}`).
- `SF.suppliers = { list(), lookup(name) }` (cache of the global directory for datalists).
- `SF.approvals = { limits(), decide(rpc, table, id, reason), eventsFor(table,id), inbox() }`.
- `SF.ui.openApprovalsInbox()`, and renderApprovals gains tabs (All / For me / By me).

## Global supplier wiring (app.js, owner: Lead; suppliers module, owner: suppliers-dev)

- New module `scripts/modules/suppliers.js` — company-level "Suppliers & Contractors" directory
  (list/add/edit/deactivate, bank/TRN fields, link to projects, shows per-project contract
  amount + active payment requests). Registers nav `section:'company'`, roles director/controller.
- `ensureSupplier(name)` (app.js) must now look up the global directory first and create/return
  the global supplier + a `project_suppliers` link for the current project; fall back to a
  `project_parties` party (legacy) so old flows keep working.
- materials/PO supplier field becomes a searchable select over the global directory.
- parties view: supplier/subcontractor parties show a "global" tag when linked.

## Tests (owner: verifier — `tools/lib/mock-supabase.mjs` fixture mirror + `tools/checks/phase1.mjs`)

- Mirror the new tables and RPCs in the mock (`sf_approve_record`, `sf_reject_record` with the
  same rules incl. SoD and limits), and add `supabase.rpc` support.
- `tools/checks/phase1.mjs` (testkit) asserts: SoD denial (creator approves own item),
  limit denial (controller over limit), director allowed, reject requires reason, events row
  written, CAS double-approve denied, inbox tabs partition items, supplier master lookup +
  project link, and RLS/migration idempotency (static greps).
