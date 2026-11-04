-- ============================================================================
-- 202611050001_phase1_accountability.sql
-- SiteForge ERP — Phase 1: server-side accountability + supplier/contractor master
--
-- Authoritative spec: docs/modules/phase1-plan.md
--
-- Purpose
--   Moves authority server-side: an immutable approval_events log, limits of
--   authority (approval_limits), segregation of duties (creator cannot approve
--   their own submission) and a company-wide supplier/contractor directory.
--   Two security-definer RPCs (sf_approve_record / sf_reject_record) are the
--   enforcement point for role, limits, SoD and the pending->decided CAS; RLS
--   below only stops casual cross-user tampering, so direct status writes are
--   deliberately NOT blocked at the RLS layer.
--
-- What it creates / alters
--   1. New tables: suppliers, project_suppliers, approval_limits, approval_events.
--   2. `created_by text` on materials, boq_items, change_orders, timesheets,
--      company_expenses (payment_requests already has requested_by; use it as
--      the creator column). Existing NULLs are backfilled to '—' (unknown) so
--      SoD never blocks historical rows.
--   3. Shared role/actor helpers sf_current_role() and sf_current_user()
--      (create or replace; security definer; search_path = public).
--   4. RPCs sf_approve_record / sf_reject_record (security definer).
--   5. RLS for the new tables + the operational approval tables.
--
-- Out of scope (intentionally NOT touched by this migration):
--   profiles, projects, companies, payments, payroll_batches, and every other
--   table not listed above (project_parties, workers, payslips, budget lines,
--   finance_settings, storage.objects, …).
--
-- Idempotency
--   Every statement is safe to re-run: create table if not exists, add column
--   if not exists, create or replace function, drop policy if exists + create
--   policy, create index if not exists. Ends with notify pgrst reload schema.
--
-- Notes
--   * gen_random_uuid() is built into PostgreSQL 13+; Supabase projects are
--     PG15+, so no `create extension pgcrypto` is required.
--   * Manager roles are 'director' and 'controller' (docs/modules/CONTRACT.md).
--   * The reject-reason column differs across tables: materials / boq_items /
--     change_orders / timesheets / company_expenses use `rejection_reason`
--     (added by 202611031004), while payment_requests uses `rejected_reason`
--     (added by 202611031001). The RPCs map this per table.
--   * payment_requests' pending status is 'submitted' (not 'pending'); the CAS
--     accepts `status in ('pending','submitted')` so it works for every table.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New tables
-- ----------------------------------------------------------------------------

-- Company-level supplier / subcontractor directory (reused across projects,
-- parties, POs and payment requests).
create table if not exists public.suppliers (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid references public.companies(id) on delete cascade,
  name               text not null,
  kind               text not null check (kind in ('supplier','subcontractor','both')),
  trade              text,
  trn                text,
  contact_person     text,
  phone              text,
  email              text,
  address            text,
  bank_name          text,
  iban               text,
  account_no         text,
  payment_terms_days integer default 30,
  vat_pct            numeric(5,2) default 5,
  status             text not null default 'active' check (status in ('active','inactive','blocked')),
  created_by         text,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- Link a global supplier to a project, with the per-project contract amount.
create table if not exists public.project_suppliers (
  project_id          uuid references public.projects(id) on delete cascade,
  supplier_id         uuid references public.suppliers(id) on delete cascade,
  contract_amount_aed numeric(14,2),
  reference           text,
  notes               text,
  primary key (project_id, supplier_id)
);

-- Limits of authority: which role may decide which table up to what amount.
-- 0 = may not approve this (company, role, table).
create table if not exists public.approval_limits (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid references public.companies(id) on delete cascade,
  role           text not null,                      -- director / controller / super
  table_name     text not null,                      -- materials, change_orders, payment_requests, company_expenses, timesheets, boq_items
  max_amount_aed numeric(14,2) not null,
  constraint approval_limits_company_role_table_key unique (company_id, role, table_name)
);

-- Immutable append-only approval timeline. No update/delete policy for anyone:
-- rows are written only by the security-definer RPCs.
create table if not exists public.approval_events (
  id          bigint generated always as identity primary key,
  company_id  uuid,
  project_id  uuid,
  table_name  text not null,
  record_id   uuid not null,
  action      text not null,                          -- submit / approve / reject / pay / certify / resubmit
  from_status text,
  to_status   text,
  amount_aed  numeric(14,2),
  actor_id    uuid,
  actor_name  text,
  actor_role  text,
  reason      text,
  before_data jsonb,
  after_data  jsonb,
  created_at  timestamptz default now()
);

comment on table public.suppliers is
  'Company-level supplier/subcontractor directory (scripts/modules/suppliers.js). One master record reused across projects, parties, POs and payment requests.';
comment on table public.project_suppliers is
  'Links a global supplier to a project with the per-project contract amount.';
comment on table public.approval_limits is
  'Limits of authority: max amount (AED) a role may decide for a table in a company. 0 = may not approve.';
comment on table public.approval_events is
  'Append-only approval/decision timeline. No update/delete policy for anyone; rows are inserted only by the security-definer RPCs.';

-- Lookup indexes (the approval_limits unique constraint already indexes
-- company_id + role + table_name; project_suppliers PK indexes project_id).
create index if not exists suppliers_company_name_idx
  on public.suppliers (company_id, name);

create index if not exists project_suppliers_supplier_idx
  on public.project_suppliers (supplier_id);

create index if not exists approval_events_table_record_idx
  on public.approval_events (table_name, record_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 1.6 Seed default limits of authority (idempotent).
--     The RPC fails closed, so a fresh install with zero approval_limits rows
--     would lock controllers (and super) out of every decision. Seed sensible
--     defaults per company: controller 100,000 AED on all six approval tables,
--     super 25,000 AED. Director is unlimited and needs no row.
-- ----------------------------------------------------------------------------
insert into public.approval_limits (company_id, role, table_name, max_amount_aed)
select c.id, r.role, t.table_name, r.max_amount_aed
from public.companies c
cross join (values
  ('controller', 100000::numeric(14,2)),
  ('super',     25000::numeric(14,2))
) as r(role, max_amount_aed)
cross join (values
  ('materials'),
  ('boq_items'),
  ('change_orders'),
  ('timesheets'),
  ('company_expenses'),
  ('payment_requests')
) as t(table_name)
on conflict (company_id, role, table_name) do nothing;

-- ----------------------------------------------------------------------------
-- 2. Creator columns for segregation of duties
-- ----------------------------------------------------------------------------
alter table public.materials        add column if not exists created_by text;
alter table public.boq_items        add column if not exists created_by text;
alter table public.change_orders    add column if not exists created_by text;
alter table public.timesheets       add column if not exists created_by text;
alter table public.company_expenses add column if not exists created_by text;
-- payment_requests already has requested_by; use it as the creator column.

-- Backfill existing rows' created_by = '—' (unknown) so SoD never blocks history.
update public.materials        set created_by = '—' where created_by is null;
update public.boq_items        set created_by = '—' where created_by is null;
update public.change_orders    set created_by = '—' where created_by is null;
update public.timesheets       set created_by = '—' where created_by is null;
update public.company_expenses set created_by = '—' where created_by is null;

-- ----------------------------------------------------------------------------
-- 3. Server-side role + actor helpers (create or replace; shared across module
--    migrations — identical definition, safe to re-run in any order)
-- ----------------------------------------------------------------------------
create or replace function public.sf_current_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.sf_current_user() returns text
language sql stable security definer set search_path = public as $$
  select name from public.profiles where id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- 4. RPCs — server-side decide (approve / reject)
--    Enforcement order: role -> resolve amount -> limits -> SoD -> CAS -> event.
-- ----------------------------------------------------------------------------

-- Approve a pending/submitted record (director unlimited; controller needs an
-- approval_limits row >= the record amount).
create or replace function public.sf_approve_record(
  p_table  text,
  p_id     uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role         text;
  v_user         text;
  v_company_id   uuid;
  v_project_id   uuid;
  v_creator      text;
  v_amount       numeric(14,2);
  v_status       text;
  v_amount_expr  text;
  v_creator_col  text;
  v_company_expr text;
  v_project_expr text;
  v_reject_col   text;
  v_new_status   text := 'approved';
  v_action       text := 'approve';
  v_before       jsonb;
  v_after        jsonb;
  v_sql          text;
  v_updated      integer := 0;
begin
  v_role := coalesce(public.sf_current_role(), '');
  v_user := coalesce(public.sf_current_user(), '');

  -- 1. Role gate: only director/controller may decide.
  if v_role not in ('director', 'controller') then
    return jsonb_build_object('ok', false, 'message', 'Insufficient role: only director or controller may decide records.', 'status', null);
  end if;

  -- Whitelist + per-table expressions (amount, creator, company, project).
  if p_table = 'materials' then
    v_amount_expr  := 'r.quantity * r.unit_cost_aed';
    v_creator_col  := 'r.created_by';
    v_company_expr := '(select p.company_id from public.projects p where p.id = r.project_id)';
    v_project_expr := 'r.project_id';
    v_reject_col   := 'rejection_reason';
  elsif p_table = 'boq_items' then
    v_amount_expr  := 'r.quantity * r.rate';
    v_creator_col  := 'r.created_by';
    v_company_expr := '(select p.company_id from public.projects p where p.id = r.project_id)';
    v_project_expr := 'r.project_id';
    v_reject_col   := 'rejection_reason';
  elsif p_table = 'change_orders' then
    v_amount_expr  := 'r.amount';
    v_creator_col  := 'r.created_by';
    v_company_expr := '(select p.company_id from public.projects p where p.id = r.project_id)';
    v_project_expr := 'r.project_id';
    v_reject_col   := 'rejection_reason';
  elsif p_table = 'timesheets' then
    v_amount_expr  := 'r.total_cost_aed';
    v_creator_col  := 'r.created_by';
    v_company_expr := '(select p.company_id from public.projects p where p.id = r.project_id)';
    v_project_expr := 'r.project_id';
    v_reject_col   := 'rejection_reason';
  elsif p_table = 'company_expenses' then
    v_amount_expr  := 'r.amount';
    v_creator_col  := 'r.created_by';
    v_company_expr := 'r.company_id';
    v_project_expr := 'null::uuid';
    v_reject_col   := 'rejection_reason';
  elsif p_table = 'payment_requests' then
    v_amount_expr  := 'r.net_aed';
    v_creator_col  := 'r.requested_by';
    v_company_expr := '(select p.company_id from public.projects p where p.id = r.project_id)';
    v_project_expr := 'r.project_id';
    v_reject_col   := 'rejected_reason';
  else
    return jsonb_build_object('ok', false, 'message', 'Unknown table "' || p_table || '".', 'status', null);
  end if;

  -- 2. Resolve the record + amount.
  v_sql := format(
    'select %s, %s, %s, %s, r.status from public.%I r where r.id = $1',
    v_company_expr, v_project_expr, v_creator_col, v_amount_expr, p_table
  );
  execute v_sql into v_company_id, v_project_id, v_creator, v_amount, v_status using p_id;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'Record not found in ' || p_table || '.', 'status', null);
  end if;

  -- 3. Limits of authority: director unlimited; controller needs a limit row
  --    (fail closed when absent).
  if v_role in ('controller', 'super') then
    if not exists (
      select 1
      from public.approval_limits al
      where al.company_id = v_company_id
        and al.role = v_role
        and al.table_name = p_table
        and al.max_amount_aed >= coalesce(v_amount, 0)
    ) then
      return jsonb_build_object('ok', false, 'message', 'Over limit: no approval limit authorises this amount.', 'status', null);
    end if;
  end if;

  -- 4. Segregation of duties: the actor must differ from the creator.
  if v_creator = v_user then
    return jsonb_build_object('ok', false, 'message', 'You cannot approve your own submission.', 'status', null);
  end if;

  v_before := jsonb_build_object('status', v_status);
  v_after  := jsonb_build_object('status', v_new_status);

  -- 5. CAS: only pending/submitted rows may be decided; 0 rows => already decided.
  --    ('submitted' covers payment_requests, whose pending status is 'submitted'.)
  v_sql := format(
    'update public.%I set status = ''approved'', approved_by = $1, approved_at = now() where id = $2 and status in (''pending'', ''submitted'')',
    p_table
  );
  execute v_sql using v_user, p_id;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return jsonb_build_object('ok', false, 'message', 'Already decided (record is not pending/submitted).', 'status', null);
  end if;

  -- 6. Append the approval event.
  insert into public.approval_events
    (company_id, project_id, table_name, record_id, action, from_status, to_status,
     amount_aed, actor_id, actor_name, actor_role, reason, before_data, after_data)
  values
    (v_company_id, v_project_id, p_table, p_id, v_action, v_status, v_new_status,
     coalesce(v_amount, 0), auth.uid(), v_user, v_role, p_reason, v_before, v_after);

  return jsonb_build_object('ok', true, 'message', 'Record ' || v_new_status || '.', 'status', v_new_status);
end;
$$;

-- Reject a pending/submitted record. A reason is required.
create or replace function public.sf_reject_record(
  p_table  text,
  p_id     uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role         text;
  v_user         text;
  v_company_id   uuid;
  v_project_id   uuid;
  v_creator      text;
  v_amount       numeric(14,2);
  v_status       text;
  v_amount_expr  text;
  v_creator_col  text;
  v_company_expr text;
  v_project_expr text;
  v_reject_col   text;
  v_new_status   text := 'rejected';
  v_action       text := 'reject';
  v_before       jsonb;
  v_after        jsonb;
  v_sql          text;
  v_updated      integer := 0;
begin
  v_role := coalesce(public.sf_current_role(), '');
  v_user := coalesce(public.sf_current_user(), '');

  -- Rejection always needs a reason.
  if coalesce(p_reason, '') = '' then
    return jsonb_build_object('ok', false, 'message', 'A rejection reason is required.', 'status', null);
  end if;

  -- 1. Role gate.
  if v_role not in ('director', 'controller') then
    return jsonb_build_object('ok', false, 'message', 'Insufficient role: only director or controller may decide records.', 'status', null);
  end if;

  -- Whitelist + per-table expressions.
  if p_table = 'materials' then
    v_amount_expr  := 'r.quantity * r.unit_cost_aed';
    v_creator_col  := 'r.created_by';
    v_company_expr := '(select p.company_id from public.projects p where p.id = r.project_id)';
    v_project_expr := 'r.project_id';
    v_reject_col   := 'rejection_reason';
  elsif p_table = 'boq_items' then
    v_amount_expr  := 'r.quantity * r.rate';
    v_creator_col  := 'r.created_by';
    v_company_expr := '(select p.company_id from public.projects p where p.id = r.project_id)';
    v_project_expr := 'r.project_id';
    v_reject_col   := 'rejection_reason';
  elsif p_table = 'change_orders' then
    v_amount_expr  := 'r.amount';
    v_creator_col  := 'r.created_by';
    v_company_expr := '(select p.company_id from public.projects p where p.id = r.project_id)';
    v_project_expr := 'r.project_id';
    v_reject_col   := 'rejection_reason';
  elsif p_table = 'timesheets' then
    v_amount_expr  := 'r.total_cost_aed';
    v_creator_col  := 'r.created_by';
    v_company_expr := '(select p.company_id from public.projects p where p.id = r.project_id)';
    v_project_expr := 'r.project_id';
    v_reject_col   := 'rejection_reason';
  elsif p_table = 'company_expenses' then
    v_amount_expr  := 'r.amount';
    v_creator_col  := 'r.created_by';
    v_company_expr := 'r.company_id';
    v_project_expr := 'null::uuid';
    v_reject_col   := 'rejection_reason';
  elsif p_table = 'payment_requests' then
    v_amount_expr  := 'r.net_aed';
    v_creator_col  := 'r.requested_by';
    v_company_expr := '(select p.company_id from public.projects p where p.id = r.project_id)';
    v_project_expr := 'r.project_id';
    v_reject_col   := 'rejected_reason';
  else
    return jsonb_build_object('ok', false, 'message', 'Unknown table "' || p_table || '".', 'status', null);
  end if;

  -- 2. Resolve the record + amount.
  v_sql := format(
    'select %s, %s, %s, %s, r.status from public.%I r where r.id = $1',
    v_company_expr, v_project_expr, v_creator_col, v_amount_expr, p_table
  );
  execute v_sql into v_company_id, v_project_id, v_creator, v_amount, v_status using p_id;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'Record not found in ' || p_table || '.', 'status', null);
  end if;

  -- 3. Limits of authority.
  if v_role in ('controller', 'super') then
    if not exists (
      select 1
      from public.approval_limits al
      where al.company_id = v_company_id
        and al.role = v_role
        and al.table_name = p_table
        and al.max_amount_aed >= coalesce(v_amount, 0)
    ) then
      return jsonb_build_object('ok', false, 'message', 'Over limit: no approval limit authorises this amount.', 'status', null);
    end if;
  end if;

  -- 4. Segregation of duties.
  if v_creator = v_user then
    return jsonb_build_object('ok', false, 'message', 'You cannot reject your own submission.', 'status', null);
  end if;

  v_before := jsonb_build_object('status', v_status);
  v_after  := jsonb_build_object('status', v_new_status, 'rejection_reason', p_reason);

  -- 5. CAS: only pending/submitted rows may be decided; 0 rows => already decided.
  v_sql := format(
    'update public.%I set status = ''rejected'', %I = $1, approved_by = $2, approved_at = now() where id = $3 and status in (''pending'', ''submitted'')',
    p_table, v_reject_col
  );
  execute v_sql using p_reason, v_user, p_id;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return jsonb_build_object('ok', false, 'message', 'Already decided (record is not pending/submitted).', 'status', null);
  end if;

  -- 6. Append the rejection event.
  insert into public.approval_events
    (company_id, project_id, table_name, record_id, action, from_status, to_status,
     amount_aed, actor_id, actor_name, actor_role, reason, before_data, after_data)
  values
    (v_company_id, v_project_id, p_table, p_id, v_action, v_status, v_new_status,
     coalesce(v_amount, 0), auth.uid(), v_user, v_role, p_reason, v_before, v_after);

  return jsonb_build_object('ok', true, 'message', 'Record ' || v_new_status || '.', 'status', v_new_status);
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. Row-level security
-- ----------------------------------------------------------------------------

-- 5.1 approval_events: append-only. Select for any signed-in user; NO
--     insert/update/delete policy (rows are written only by the definer RPCs).
alter table public.approval_events enable row level security;

drop policy if exists approval_events_select on public.approval_events;
create policy approval_events_select on public.approval_events
  for select to authenticated
  using (true);

-- 5.2 suppliers: read all; write director/controller.
alter table public.suppliers enable row level security;

drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers
  for select to authenticated
  using (true);

drop policy if exists suppliers_insert on public.suppliers;
create policy suppliers_insert on public.suppliers
  for insert to authenticated
  with check (public.sf_current_role() in ('director', 'controller'));

drop policy if exists suppliers_update on public.suppliers;
create policy suppliers_update on public.suppliers
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller'))
  with check (public.sf_current_role() in ('director', 'controller'));

drop policy if exists suppliers_delete on public.suppliers;
create policy suppliers_delete on public.suppliers
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller'));

-- 5.3 project_suppliers: read all; write director/controller/super.
alter table public.project_suppliers enable row level security;

drop policy if exists project_suppliers_select on public.project_suppliers;
create policy project_suppliers_select on public.project_suppliers
  for select to authenticated
  using (true);

drop policy if exists project_suppliers_insert on public.project_suppliers;
create policy project_suppliers_insert on public.project_suppliers
  for insert to authenticated
  with check (public.sf_current_role() in ('director', 'controller', 'super'));

drop policy if exists project_suppliers_update on public.project_suppliers;
create policy project_suppliers_update on public.project_suppliers
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller', 'super'))
  with check (public.sf_current_role() in ('director', 'controller', 'super'));

drop policy if exists project_suppliers_delete on public.project_suppliers;
create policy project_suppliers_delete on public.project_suppliers
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller', 'super'));

-- 5.4 approval_limits: read all; write director only.
alter table public.approval_limits enable row level security;

drop policy if exists approval_limits_select on public.approval_limits;
create policy approval_limits_select on public.approval_limits
  for select to authenticated
  using (true);

drop policy if exists approval_limits_insert on public.approval_limits;
create policy approval_limits_insert on public.approval_limits
  for insert to authenticated
  with check (public.sf_current_role() in ('director'));

drop policy if exists approval_limits_update on public.approval_limits;
create policy approval_limits_update on public.approval_limits
  for update to authenticated
  using (public.sf_current_role() in ('director'))
  with check (public.sf_current_role() in ('director'));

drop policy if exists approval_limits_delete on public.approval_limits;
create policy approval_limits_delete on public.approval_limits
  for delete to authenticated
  using (public.sf_current_role() in ('director'));

-- 5.5 Operational approval tables. For payment_requests the creator column is
--     requested_by (it has no created_by); all other tables use created_by.
--     These policies stop casual cross-user tampering only — the RPCs are the
--     enforcement point for role/limits/SoD.
alter table public.materials enable row level security;
alter table public.boq_items enable row level security;
alter table public.change_orders enable row level security;
alter table public.timesheets enable row level security;
alter table public.company_expenses enable row level security;
alter table public.payment_requests enable row level security;

-- materials ------------------------------------------------------------------
drop policy if exists materials_select on public.materials;
create policy materials_select on public.materials
  for select to authenticated using (true);

drop policy if exists materials_insert on public.materials;
create policy materials_insert on public.materials
  for insert to authenticated with check (true);

drop policy if exists materials_update on public.materials;
create policy materials_update on public.materials
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user())
  with check (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user());

drop policy if exists materials_delete on public.materials;
create policy materials_delete on public.materials
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user());

-- boq_items ------------------------------------------------------------------
drop policy if exists boq_items_select on public.boq_items;
create policy boq_items_select on public.boq_items
  for select to authenticated using (true);

drop policy if exists boq_items_insert on public.boq_items;
create policy boq_items_insert on public.boq_items
  for insert to authenticated with check (true);

drop policy if exists boq_items_update on public.boq_items;
create policy boq_items_update on public.boq_items
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user())
  with check (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user());

drop policy if exists boq_items_delete on public.boq_items;
create policy boq_items_delete on public.boq_items
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user());

-- change_orders --------------------------------------------------------------
drop policy if exists change_orders_select on public.change_orders;
create policy change_orders_select on public.change_orders
  for select to authenticated using (true);

drop policy if exists change_orders_insert on public.change_orders;
create policy change_orders_insert on public.change_orders
  for insert to authenticated with check (true);

drop policy if exists change_orders_update on public.change_orders;
create policy change_orders_update on public.change_orders
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user())
  with check (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user());

drop policy if exists change_orders_delete on public.change_orders;
create policy change_orders_delete on public.change_orders
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user());

-- timesheets -----------------------------------------------------------------
drop policy if exists timesheets_select on public.timesheets;
create policy timesheets_select on public.timesheets
  for select to authenticated using (true);

drop policy if exists timesheets_insert on public.timesheets;
create policy timesheets_insert on public.timesheets
  for insert to authenticated with check (true);

drop policy if exists timesheets_update on public.timesheets;
create policy timesheets_update on public.timesheets
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user())
  with check (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user());

drop policy if exists timesheets_delete on public.timesheets;
create policy timesheets_delete on public.timesheets
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user());

-- company_expenses -----------------------------------------------------------
drop policy if exists company_expenses_select on public.company_expenses;
create policy company_expenses_select on public.company_expenses
  for select to authenticated using (true);

drop policy if exists company_expenses_insert on public.company_expenses;
create policy company_expenses_insert on public.company_expenses
  for insert to authenticated with check (true);

drop policy if exists company_expenses_update on public.company_expenses;
create policy company_expenses_update on public.company_expenses
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user())
  with check (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user());

drop policy if exists company_expenses_delete on public.company_expenses;
create policy company_expenses_delete on public.company_expenses
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller') or created_by = public.sf_current_user());

-- payment_requests (creator = requested_by) -----------------------------------
drop policy if exists payment_requests_select on public.payment_requests;
create policy payment_requests_select on public.payment_requests
  for select to authenticated using (true);

drop policy if exists payment_requests_insert on public.payment_requests;
create policy payment_requests_insert on public.payment_requests
  for insert to authenticated with check (true);

drop policy if exists payment_requests_update on public.payment_requests;
create policy payment_requests_update on public.payment_requests
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller') or requested_by = public.sf_current_user())
  with check (public.sf_current_role() in ('director', 'controller') or requested_by = public.sf_current_user());

drop policy if exists payment_requests_delete on public.payment_requests;
create policy payment_requests_delete on public.payment_requests
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller') or requested_by = public.sf_current_user());

-- ----------------------------------------------------------------------------
-- 6. Grants
-- ----------------------------------------------------------------------------
grant select on public.approval_events to authenticated;
grant select, insert, update, delete on public.suppliers to authenticated;
grant select, insert, update, delete on public.project_suppliers to authenticated;
grant select, insert, update, delete on public.approval_limits to authenticated;

-- Operational tables keep full DML grants; RLS narrows the actual access.
grant select, insert, update, delete on public.materials to authenticated;
grant select, insert, update, delete on public.boq_items to authenticated;
grant select, insert, update, delete on public.change_orders to authenticated;
grant select, insert, update, delete on public.timesheets to authenticated;
grant select, insert, update, delete on public.company_expenses to authenticated;
grant select, insert, update, delete on public.payment_requests to authenticated;

-- Ask PostgREST to pick up the new tables/columns/functions immediately.
notify pgrst, 'reload schema';
