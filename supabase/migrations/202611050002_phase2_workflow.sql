-- ============================================================================
-- 202611050002_phase2_workflow.sql
-- SiteForge ERP — Phase 2: evidence, period close, SLA escalation, 3-way match
--
-- Authoritative spec: docs/modules/phase2-plan.md
--
-- Purpose
--   Server-side guardrails for the workflow layer:
--   1. Approval evidence (approval_attachments) with per-company/table
--      minimum-amount thresholds (approval_attachment_rules).
--   2. Period close: closed_periods + sf_assert_period_open() + a trigger
--      sf_guard_closed_period() that freezes dated writes in a closed month.
--   3. SLA escalation: approval_sla + sf_escalate_overdue() inserts an
--      'escalation' notification for pending records older than sla_days.
--   4. 3-way match: goods_received_notes + sf_material_grn() returning the
--      received qty vs ordered qty match.
--
-- What it creates / attaches
--   1. New tables: approval_attachments, approval_attachment_rules,
--      closed_periods, approval_sla, goods_received_notes.
--   2. Functions: sf_assert_period_open, sf_guard_closed_period,
--      sf_material_grn, sf_escalate_overdue.
--   3. BEFORE INSERT OR UPDATE triggers on the six dated tables:
--      timesheets, company_expenses, payments, payroll_batches,
--      progress_billings, materials.
--   4. RLS for the five new tables.
--   5. Optional pg_cron schedule (only if the extension is installed).
--
-- Out of scope (intentionally NOT touched by this migration):
--   profiles, projects, companies (read-only via FKs / lookups only) and any
--   table not listed above. NOTE: unlike Phase 1, this migration DOES attach a
--   trigger to payments, payroll_batches and progress_billings — the plan lists
--   them explicitly for period-close, so they are in scope here.
--
-- Idempotency
--   create table if not exists / create or replace function / drop trigger if
--   exists + create trigger / drop policy if exists + create policy / create
--   index if not exists / guarded seeds. Ends with notify pgrst reload schema.
--
-- Notes
--   * Reuses the shared helpers sf_current_role() / sf_current_user() defined
--     in 202611050001 — they are NOT redefined here.
--   * manager roles are 'director' and 'controller' (docs/modules/CONTRACT.md);
--     'super' may also create GRNs per the plan.
--   * payment_requests' pending status is 'submitted' (not 'pending').
--   * notifications' optional columns are probed via information_schema so the
--     escalation stays best-effort against whichever base schema is deployed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New tables
-- ----------------------------------------------------------------------------

-- Evidence attached to an approval record (PO / change order / expense /
-- payment request / timesheet). Append + delete only; no update policy.
create table if not exists public.approval_attachments (
  id          uuid primary key default gen_random_uuid(),
  table_name  text not null,   -- materials / change_orders / company_expenses / payment_requests / timesheets
  record_id   uuid not null,
  file_path   text not null,
  file_name   text not null,
  file_size   bigint,
  mime_type   text,
  uploaded_by text,
  created_at  timestamptz default now()
);

-- Minimum amount (AED) above which evidence is required before submit.
-- 0 = evidence never required for this (company, table).
create table if not exists public.approval_attachment_rules (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid references public.companies(id) on delete cascade,
  table_name     text not null,
  min_amount_aed numeric(14,2) not null default 0,
  constraint approval_attachment_rules_company_table_key unique (company_id, table_name)
);

-- A closed accounting period ('YYYY-MM'); dated writes for the period are denied.
create table if not exists public.closed_periods (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  period     text not null,      -- 'YYYY-MM'
  closed_at  timestamptz default now(),
  closed_by  text,
  reason     text,
  constraint closed_periods_company_period_key unique (company_id, period)
);

-- SLA escalation threshold per company (days before a pending record escalates).
create table if not exists public.approval_sla (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete cascade,
  sla_days    int not null default 3,
  escalate_to text,              -- role or email; informational
  updated_at  timestamptz default now()
);

-- Goods received notes (3-way match): qty received against a PO line/material.
create table if not exists public.goods_received_notes (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references public.projects(id) on delete cascade,
  material_id   text,  -- materials.id is TEXT in this deployment (no FK; app joins by value)
  supplier_id   uuid references public.suppliers(id) on delete set null,
  reference     text not null,   -- GRN-0001 (unique per project, enforced by the app)
  received_date date not null,
  qty_received  numeric(14,2) not null check (qty_received >= 0),
  received_by   text,
  notes         text,
  status        text default 'received',
  created_at    timestamptz default now()
);

comment on table public.approval_attachments is
  'Evidence file attached to an approval record (materials/change_orders/company_expenses/payment_requests/timesheets).';
comment on table public.approval_attachment_rules is
  'Minimum amount (AED) above which evidence is required before submit; 0 = never required.';
comment on table public.closed_periods is
  'Closed accounting periods (YYYY-MM) whose dated writes are frozen by sf_guard_closed_period.';
comment on table public.approval_sla is
  'Per-company SLA escalation threshold in days (default 3).';
comment on table public.goods_received_notes is
  'Goods received notes for 3-way match: received qty vs ordered qty on a material.';

-- ----------------------------------------------------------------------------
-- 1.1 Lookup indexes (the unique constraints already index their leading cols).
-- ----------------------------------------------------------------------------
create index if not exists approval_attachments_table_record_idx
  on public.approval_attachments (table_name, record_id);

create index if not exists goods_received_notes_material_idx
  on public.goods_received_notes (material_id);

create index if not exists goods_received_notes_project_idx
  on public.goods_received_notes (project_id);

-- ----------------------------------------------------------------------------
-- 1.2 Seed per-company defaults (idempotent).
-- ----------------------------------------------------------------------------

-- Evidence thresholds per approval table. 0 = evidence never required.
insert into public.approval_attachment_rules (company_id, table_name, min_amount_aed)
select c.id, t.table_name, t.min_amount_aed
from public.companies c
cross join (values
  ('materials',        25000::numeric(14,2)),
  ('change_orders',    10000::numeric(14,2)),
  ('payment_requests', 50000::numeric(14,2)),
  ('company_expenses',  5000::numeric(14,2)),
  ('timesheets',           0::numeric(14,2))
) as t(table_name, min_amount_aed)
on conflict (company_id, table_name) do nothing;

-- Default SLA: 3 days per company. approval_sla has no unique key in the spec,
-- so seed via a NOT EXISTS guard to stay idempotent.
insert into public.approval_sla (company_id, sla_days)
select c.id, 3
from public.companies c
where not exists (
  select 1 from public.approval_sla s where s.company_id = c.id
);

-- ----------------------------------------------------------------------------
-- 2. Functions
-- ----------------------------------------------------------------------------

-- Raise if the month of p_date is closed for p_company. NULL inputs are
-- treated as "cannot determine" and pass through (the trigger also guards).
create or replace function public.sf_assert_period_open(
  p_company uuid,
  p_date    date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period text;
begin
  if p_company is null or p_date is null then
    return;
  end if;

  v_period := to_char(p_date, 'YYYY-MM');

  if exists (
    select 1
    from public.closed_periods cp
    where cp.company_id = p_company
      and cp.period = v_period
  ) then
    raise exception 'CLOSED_PERIOD: period % is closed for this company.', v_period
      using errcode = 'P0001';
  end if;
end;
$$;

-- BEFORE INSERT OR UPDATE guard on the dated tables. Maps TG_TABLE_NAME to its
-- date column, resolves the company, and asserts the period is open.
--   timesheets         -> work_date     (company via project_id -> projects.company_id)
--   company_expenses   -> expense_date  (company via company_id)
--   payments           -> paid_date (fallback due_date) (company via project_id)
--   payroll_batches    -> period 'YYYY-MM' -> first of month (company via project_id)
--   progress_billings  -> period_from   (company via project_id)
--   materials          -> invoice_date  (company via project_id)
create or replace function public.sf_guard_closed_period()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_date       date;
begin
  if TG_TABLE_NAME = 'timesheets' then
    v_date       := NEW.work_date;
    v_company_id := (select p.company_id from public.projects p where p.id = NEW.project_id);
  elsif TG_TABLE_NAME = 'company_expenses' then
    v_date       := NEW.expense_date;
    v_company_id := NEW.company_id;
  elsif TG_TABLE_NAME = 'payments' then
    v_date       := coalesce(NEW.paid_date, NEW.due_date);
    v_company_id := (select p.company_id from public.projects p where p.id = NEW.project_id);
  elsif TG_TABLE_NAME = 'payroll_batches' then
    v_date       := (NEW.period || '-01')::date;   -- period is 'YYYY-MM'
    v_company_id := (select p.company_id from public.projects p where p.id = NEW.project_id);
  elsif TG_TABLE_NAME = 'progress_billings' then
    v_date       := NEW.period_from;
    v_company_id := (select p.company_id from public.projects p where p.id = NEW.project_id);
  elsif TG_TABLE_NAME = 'materials' then
    v_date       := NEW.invoice_date;
    v_company_id := (select p.company_id from public.projects p where p.id = NEW.project_id);
  else
    -- Not one of our dated tables: pass through untouched.
    return NEW;
  end if;

  if v_company_id is null or v_date is null then
    return NEW;
  end if;

  perform public.sf_assert_period_open(v_company_id, v_date);
  return NEW;
end;
$$;

-- 3-way match: total received qty for a material and whether it is fully
-- received (received >= ordered). {"received_qty":…, "matched":bool}
create or replace function public.sf_material_grn(m_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_received numeric(14,2);
  v_ordered  numeric(14,2);
begin
  select coalesce(sum(g.qty_received), 0)
    into v_received
    from public.goods_received_notes g
   where g.material_id = m_id;

  select m.quantity
    into v_ordered
    from public.materials m
   where m.id = m_id;

  return jsonb_build_object(
    'received_qty', v_received,
    'matched',      (v_ordered is not null and v_received >= v_ordered)
  );
end;
$$;

-- Escalate pending approval records older than their company's sla_days by
-- inserting an 'escalation' notification for directors/controllers. Dedupe by
-- (table, record) via a notif_dedupe column when present; otherwise best-effort
-- (skip when an existing escalation mentions the record id, else allow dupes).
create or replace function public.sf_escalate_overdue()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_dedupe boolean;
  v_has_type   boolean;
  v_has_user   boolean;
  r            record;
  v_sla_days   int;
  v_age        int;
  v_dedupe     text;
  v_body       text;
  v_cols       text;
  v_vals       text;
  v_sql        text;
  v_found      bigint;
begin
  -- Probe the notifications schema so optional columns never break the function.
  select exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'notifications' and column_name = 'notif_dedupe')
    into v_has_dedupe;
  select exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'notifications' and column_name = 'type')
    into v_has_type;
  select exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'notifications' and column_name = 'user_id')
    into v_has_user;

  for r in
    select t.table_name, t.record_id, t.company_id, t.amount, t.created_at, t.label
    from (
      -- materials (pending PO lines)
      select 'materials'::text as table_name,
             m.id as record_id,
             (select p.company_id from public.projects p where p.id = m.project_id) as company_id,
             (coalesce(m.quantity, 0) * coalesce(m.unit_cost_aed, 0))::numeric(14,2) as amount,
             m.created_at as created_at,
             coalesce(m.po_number, m.description, 'material') as label
        from public.materials m
       where coalesce(m.status, 'approved') = 'pending'
      union all
      -- change_orders
      select 'change_orders'::text as table_name,
             c.id as record_id,
             (select p.company_id from public.projects p where p.id = c.project_id) as company_id,
             c.amount::numeric(14,2) as amount,
             c.created_at as created_at,
             coalesce(c.co_number, c.description, 'change order') as label
        from public.change_orders c
       where coalesce(c.status, 'approved') = 'pending'
      union all
      -- payment_requests (pending status is 'submitted')
      select 'payment_requests'::text as table_name,
             q.id as record_id,
             (select p.company_id from public.projects p where p.id = q.project_id) as company_id,
             coalesce(q.net_aed, q.amount_aed, 0)::numeric(14,2) as amount,
             q.created_at as created_at,
             coalesce(q.reference, q.description, 'payment request') as label
        from public.payment_requests q
       where coalesce(q.status, 'draft') = 'submitted'
      union all
      -- company_expenses (company resolved directly)
      select 'company_expenses'::text as table_name,
             e.id as record_id,
             e.company_id as company_id,
             e.amount::numeric(14,2) as amount,
             e.created_at as created_at,
             coalesce(e.description, 'expense') as label
        from public.company_expenses e
       where coalesce(e.status, 'approved') = 'pending'
      union all
      -- timesheets
      select 'timesheets'::text as table_name,
             ts.id as record_id,
             (select p.company_id from public.projects p where p.id = ts.project_id) as company_id,
             coalesce(ts.total_cost_aed, 0)::numeric(14,2) as amount,
             ts.created_at as created_at,
             coalesce(ts.employee_name, 'timesheet') as label
        from public.timesheets ts
       where coalesce(ts.status, 'approved') = 'pending'
    ) t
    where t.created_at is not null
  loop
    v_sla_days := coalesce(
      (select s.sla_days from public.approval_sla s where s.company_id = r.company_id),
      3
    );

    v_age := (current_date - r.created_at::date);
    if v_age <= v_sla_days then
      continue;
    end if;

    v_dedupe := r.table_name || ':' || r.record_id::text;

    -- Dedupe: prefer a notif_dedupe column, else a best-effort body match.
    if v_has_dedupe then
      execute 'select count(*) from public.notifications where notif_dedupe = $1'
        into v_found using v_dedupe;
      if v_found > 0 then
        continue;
      end if;
    elsif v_has_type then
      execute 'select count(*) from public.notifications where type = ''escalation'' and body like $1'
        into v_found using '%' || r.record_id::text || '%';
      if v_found > 0 then
        continue;
      end if;
    end if;

    v_body := 'Record ' || r.table_name || ' "' || coalesce(r.label, '') || '" (AED '
           || to_char(coalesce(r.amount, 0), 'FM999999999999.00')
           || ') has been pending for ' || v_age || ' day(s).';

    -- Build the insert column/value lists so optional columns are omitted cleanly.
    v_cols := '';
    v_vals := '';
    if v_has_user then
      v_cols := v_cols || 'user_id, ';
      v_vals := v_vals || 'p.id, ';
    end if;
    if v_has_type then
      v_cols := v_cols || 'type, ';
      v_vals := v_vals || '''escalation'', ';
    end if;
    if v_has_dedupe then
      v_cols := v_cols || 'notif_dedupe, ';
      v_vals := v_vals || quote_literal(v_dedupe) || ', ';
    end if;
    v_cols := v_cols || 'title, body, created_at';
    v_vals := v_vals || '''Approval overdue'', ' || quote_literal(v_body) || ', now()';

    v_sql := 'insert into public.notifications (' || v_cols || ') select ' || v_vals
          || ' from public.profiles p where p.role in (''director'', ''controller'')';
    execute v_sql;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Triggers — attach the period-close guard to the six dated tables.
-- ----------------------------------------------------------------------------
drop trigger if exists trg_guard_closed_period_timesheets on public.timesheets;
create trigger trg_guard_closed_period_timesheets
  before insert or update on public.timesheets
  for each row execute function public.sf_guard_closed_period();

drop trigger if exists trg_guard_closed_period_company_expenses on public.company_expenses;
create trigger trg_guard_closed_period_company_expenses
  before insert or update on public.company_expenses
  for each row execute function public.sf_guard_closed_period();

drop trigger if exists trg_guard_closed_period_payments on public.payments;
create trigger trg_guard_closed_period_payments
  before insert or update on public.payments
  for each row execute function public.sf_guard_closed_period();

drop trigger if exists trg_guard_closed_period_payroll_batches on public.payroll_batches;
create trigger trg_guard_closed_period_payroll_batches
  before insert or update on public.payroll_batches
  for each row execute function public.sf_guard_closed_period();

drop trigger if exists trg_guard_closed_period_progress_billings on public.progress_billings;
create trigger trg_guard_closed_period_progress_billings
  before insert or update on public.progress_billings
  for each row execute function public.sf_guard_closed_period();

drop trigger if exists trg_guard_closed_period_materials on public.materials;
create trigger trg_guard_closed_period_materials
  before insert or update on public.materials
  for each row execute function public.sf_guard_closed_period();

-- ----------------------------------------------------------------------------
-- 4. Row-level security
-- ----------------------------------------------------------------------------

-- 4.1 approval_attachments: read/insert any authenticated user; delete only
--     managers or the uploader. No update policy (append + delete only).
alter table public.approval_attachments enable row level security;

drop policy if exists approval_attachments_select on public.approval_attachments;
create policy approval_attachments_select on public.approval_attachments
  for select to authenticated
  using (true);

drop policy if exists approval_attachments_insert on public.approval_attachments;
create policy approval_attachments_insert on public.approval_attachments
  for insert to authenticated
  with check (true);

drop policy if exists approval_attachments_delete on public.approval_attachments;
create policy approval_attachments_delete on public.approval_attachments
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller')
      or uploaded_by = public.sf_current_user());

-- 4.2 approval_attachment_rules: read all; write director only.
alter table public.approval_attachment_rules enable row level security;

drop policy if exists approval_attachment_rules_select on public.approval_attachment_rules;
create policy approval_attachment_rules_select on public.approval_attachment_rules
  for select to authenticated
  using (true);

drop policy if exists approval_attachment_rules_insert on public.approval_attachment_rules;
create policy approval_attachment_rules_insert on public.approval_attachment_rules
  for insert to authenticated
  with check (public.sf_current_role() in ('director'));

drop policy if exists approval_attachment_rules_update on public.approval_attachment_rules;
create policy approval_attachment_rules_update on public.approval_attachment_rules
  for update to authenticated
  using (public.sf_current_role() in ('director'))
  with check (public.sf_current_role() in ('director'));

drop policy if exists approval_attachment_rules_delete on public.approval_attachment_rules;
create policy approval_attachment_rules_delete on public.approval_attachment_rules
  for delete to authenticated
  using (public.sf_current_role() in ('director'));

-- 4.3 closed_periods: read all; write director only.
alter table public.closed_periods enable row level security;

drop policy if exists closed_periods_select on public.closed_periods;
create policy closed_periods_select on public.closed_periods
  for select to authenticated
  using (true);

drop policy if exists closed_periods_insert on public.closed_periods;
create policy closed_periods_insert on public.closed_periods
  for insert to authenticated
  with check (public.sf_current_role() in ('director'));

drop policy if exists closed_periods_update on public.closed_periods;
create policy closed_periods_update on public.closed_periods
  for update to authenticated
  using (public.sf_current_role() in ('director'))
  with check (public.sf_current_role() in ('director'));

drop policy if exists closed_periods_delete on public.closed_periods;
create policy closed_periods_delete on public.closed_periods
  for delete to authenticated
  using (public.sf_current_role() in ('director'));

-- 4.4 approval_sla: read all; write director only.
alter table public.approval_sla enable row level security;

drop policy if exists approval_sla_select on public.approval_sla;
create policy approval_sla_select on public.approval_sla
  for select to authenticated
  using (true);

drop policy if exists approval_sla_insert on public.approval_sla;
create policy approval_sla_insert on public.approval_sla
  for insert to authenticated
  with check (public.sf_current_role() in ('director'));

drop policy if exists approval_sla_update on public.approval_sla;
create policy approval_sla_update on public.approval_sla
  for update to authenticated
  using (public.sf_current_role() in ('director'))
  with check (public.sf_current_role() in ('director'));

drop policy if exists approval_sla_delete on public.approval_sla;
create policy approval_sla_delete on public.approval_sla
  for delete to authenticated
  using (public.sf_current_role() in ('director'));

-- 4.5 goods_received_notes: read all; insert director/controller/super;
--     update/delete director/controller.
alter table public.goods_received_notes enable row level security;

drop policy if exists goods_received_notes_select on public.goods_received_notes;
create policy goods_received_notes_select on public.goods_received_notes
  for select to authenticated
  using (true);

drop policy if exists goods_received_notes_insert on public.goods_received_notes;
create policy goods_received_notes_insert on public.goods_received_notes
  for insert to authenticated
  with check (public.sf_current_role() in ('director', 'controller', 'super'));

drop policy if exists goods_received_notes_update on public.goods_received_notes;
create policy goods_received_notes_update on public.goods_received_notes
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller'))
  with check (public.sf_current_role() in ('director', 'controller'));

drop policy if exists goods_received_notes_delete on public.goods_received_notes;
create policy goods_received_notes_delete on public.goods_received_notes
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller'));

-- ----------------------------------------------------------------------------
-- 5. Grants (RLS narrows the actual access)
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.approval_attachments to authenticated;
grant select, insert, update, delete on public.approval_attachment_rules to authenticated;
grant select, insert, update, delete on public.closed_periods to authenticated;
grant select, insert, update, delete on public.approval_sla to authenticated;
grant select, insert, update, delete on public.goods_received_notes to authenticated;

-- ----------------------------------------------------------------------------
-- 6. Optional pg_cron schedule (guarded: no-op unless pg_cron is installed).
--    The app also calls sf_escalate_overdue() opportunistically after login, so
--    this schedule is a convenience, not a requirement.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Recreate idempotently (unschedule is a no-op if the job is absent).
    perform cron.unschedule('siteforge-escalate-overdue');
    perform cron.schedule(
      'siteforge-escalate-overdue',
      '0 4 * * *',
      'select public.sf_escalate_overdue();'
    );
  end if;
end
$$;

-- Ask PostgREST to pick up the new tables/columns/functions immediately.
notify pgrst, 'reload schema';
