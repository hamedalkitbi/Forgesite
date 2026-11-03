-- ============================================================================
-- 202611031003_payslips.sql
-- SiteForge ERP — printable payroll payslips (batch generated from approved
-- timesheets, per project + period).
--
-- Purpose
--   Creates public.payslips, the persistence layer behind the Payslips module
--   (scripts/modules/payslips.js). Each row is one worker's payslip for one
--   project and one payroll period (YYYY-MM). Rows are generated from approved
--   timesheets, can be edited in the module preview, then upserted as a batch.
--   Re-running generation for the same period is idempotent: the unique
--   (project_id, worker_id, period) key makes the client upsert update in place.
--
-- Who should run it
--   The project owner / Supabase admin, once, in the Supabase SQL editor
--   (or via `supabase db push`). Safe to run more than once — every statement is
--   idempotent and no existing table, column, function or policy is modified.
--
-- Rollback (manual; this migration never drops anything on its own)
--   drop policy if exists payslips_select on public.payslips;
--   drop policy if exists payslips_insert on public.payslips;
--   drop policy if exists payslips_update on public.payslips;
--   drop policy if exists payslips_delete on public.payslips;
--   drop table if exists public.payslips;
--   (sf_current_role() is shared by other module migrations — leave it in place.)
--
-- Notes
--   * gen_random_uuid() is built into PostgreSQL 13+; Supabase projects are
--     PG15+, so no `create extension pgcrypto` is required.
--   * Manager roles are 'director' and 'controller' (see docs/modules/CONTRACT.md).
--   * Unique key: (project_id, worker_id, period). NULL worker_id rows (timesheet
--     names that could not be matched to a worker) are covered by a second,
--     partial unique index on (project_id, period, lower(worker_name)) so an
--     unmatched payslip is also idempotent.
-- ============================================================================

create table if not exists public.payslips (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects(id) on delete cascade,
  worker_id             uuid references public.workers(id) on delete set null,
  worker_name           text not null,
  staff_no              text,
  period                text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  days_worked           numeric(6,2)  not null default 0 check (days_worked >= 0),
  reg_hours             numeric(8,2)  not null default 0 check (reg_hours >= 0),
  ot_hours              numeric(8,2)  not null default 0 check (ot_hours >= 0),
  hourly_rate_aed       numeric(10,2) not null default 0 check (hourly_rate_aed >= 0),
  ot_rate_aed           numeric(10,2) not null default 0 check (ot_rate_aed >= 0),
  gross_aed             numeric(14,2) not null default 0 check (gross_aed >= 0),
  loan_deduction_aed    numeric(14,2) not null default 0 check (loan_deduction_aed >= 0),
  other_deductions_aed  numeric(14,2) not null default 0 check (other_deductions_aed >= 0),
  net_aed               numeric(14,2) not null default 0 check (net_aed >= 0),
  status                text not null default 'draft' check (status in ('draft','approved','paid')),
  paid_at               timestamptz,
  notes                 text,
  created_at            timestamptz not null default now()
);

-- Upsert target for the batch save: onConflict 'project_id,worker_id,period'.
create unique index if not exists payslips_project_worker_period_uidx
  on public.payslips (project_id, worker_id, period);

-- Unmatched names are saved with worker_id = null; Postgres treats NULLs as
-- distinct in a unique index, so add a partial unique key on the display name.
create unique index if not exists payslips_unmatched_period_uidx
  on public.payslips (project_id, period, lower(worker_name))
  where worker_id is null;

-- List / filter saved payslips by project + period, newest first.
create index if not exists payslips_project_period_idx
  on public.payslips (project_id, period, created_at desc);

create index if not exists payslips_status_idx
  on public.payslips (project_id, status);

-- Role helper (create or replace is safe: identical definition shared by the
-- other module migrations in this branch).
create or replace function public.sf_current_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

alter table public.payslips enable row level security;

-- Read: any signed-in user (payslip amounts are payroll-sensitive, but the
-- module view itself is gated to director/controller, and app employees may
-- still read their own figure through other views). Follow the contract:
-- select for authenticated.
drop policy if exists payslips_select on public.payslips;
create policy payslips_select on public.payslips
  for select to authenticated
  using (true);

-- Write: managers only (director/controller), via the shared role helper.
drop policy if exists payslips_insert on public.payslips;
create policy payslips_insert on public.payslips
  for insert to authenticated
  with check (public.sf_current_role() in ('director','controller'));

drop policy if exists payslips_update on public.payslips;
create policy payslips_update on public.payslips
  for update to authenticated
  using (public.sf_current_role() in ('director','controller'))
  with check (public.sf_current_role() in ('director','controller'));

drop policy if exists payslips_delete on public.payslips;
create policy payslips_delete on public.payslips
  for delete to authenticated
  using (public.sf_current_role() in ('director','controller'));

-- PostgREST needs the table in its schema cache; the API picks it up on the next
-- schema reload (Supabase does this automatically within a few seconds).
comment on table public.payslips is
  'Payroll payslips per project/worker/period, generated from approved timesheets by scripts/modules/payslips.js';
comment on column public.payslips.notes is
  'Free text; records loan shortfall (balance beyond gross) carried forward to the next period plus generation warnings';
