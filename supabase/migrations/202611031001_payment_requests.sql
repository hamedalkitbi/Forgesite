-- ============================================================================
-- 202611031001_payment_requests.sql
-- SiteForge ERP — project-level Payment Requests for subcontractors & suppliers
-- (submit → approve/reject → pay workflow, retention + advance recovery,
-- ageing and printable payment-request documents).
--
-- Purpose
--   Creates public.payment_requests, the persistence layer behind the Payment
--   Requests module (scripts/modules/payment-requests.js). One row is one
--   payment request raised against one project for one subcontractor or
--   supplier party. The row carries the certified amount, the retention
--   deduction, the advance-recovery deduction and the resulting net payable,
--   plus the approval / rejection / payment audit fields used by the view.
--
--   Lifecycle (status):
--     draft → submitted → approved → paid
--                       ↘ rejected → (resubmitted) → submitted → …
--   Overdue is a derived property, not a stored status:
--     overdue = due_date < current_date and status not in ('paid','rejected')
--
-- Who should run it
--   The project owner / Supabase admin, once, in the Supabase SQL editor (or
--   via `supabase db push`). Safe to run more than once: table/index/function
--   creation is idempotent, policies are dropped-and-recreated, and no existing
--   table, column or function is modified destructively.
--
-- Rollback (manual; this migration never drops anything on its own)
--   drop policy if exists payment_requests_select on public.payment_requests;
--   drop policy if exists payment_requests_insert on public.payment_requests;
--   drop policy if exists payment_requests_update on public.payment_requests;
--   drop policy if exists payment_requests_delete on public.payment_requests;
--   drop trigger if exists trg_payment_requests_compute_amounts on public.payment_requests;
--   drop function if exists public.payment_requests_compute_amounts();
--   drop table if exists public.payment_requests;
--   (public.sf_current_role() is shared by the other module migrations — leave
--    it in place when rolling this one back.)
--
-- Notes
--   * gen_random_uuid() is built into PostgreSQL 13+; Supabase projects are
--     PG15+, so no `create extension pgcrypto` is required.
--   * Manager-only actions (approve / reject / pay / edit / delete in the UI)
--     are director + controller. `super` may raise and submit requests, so the
--     write policies include 'super' (per module spec); the sidebar view is
--     gated to director/controller/super by the module registration.
--   * retention_aed and net_aed are stored (not GENERATED) because the client
--     renders and validates them before the row exists, and because the module
--     must work against a mocked PostgREST in tests. The BEFORE trigger
--     re-derives both values from amount_aed/retention_pct/advance_recovery_aed
--     on every write that touches those inputs, so direct API writes cannot
--     store inconsistent arithmetic. Formula:
--       retention_aed = round(amount_aed * retention_pct / 100, 2)
--       net_aed       = round(amount_aed - retention_aed - advance_recovery_aed, 2)
--     and net_aed < 0 is rejected (client validation + DB check + trigger).
--   * advance_recovery_aed is required by the net formula in the feature spec;
--     it is added here (the spec's column list mentions the deduction but omits
--     the column name).
--   * Reference: 'PR-' || zero-padded sequence, unique per project
--     (unique (project_id, reference)). The client derives the next number from
--     existing references and retries on a unique violation, so two users
--     creating at once cannot end up with a duplicate.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------------------
create table if not exists public.payment_requests (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects(id) on delete cascade,
  party_id             uuid references public.project_parties(id) on delete set null,
  request_type         text not null check (request_type in ('subcontractor','supplier')),
  reference            text not null check (length(trim(reference)) > 0),
  description          text not null,
  amount_aed           numeric(14,2) not null check (amount_aed > 0),
  retention_pct        numeric(5,2)  not null default 0 check (retention_pct >= 0 and retention_pct <= 100),
  retention_aed        numeric(14,2) not null default 0 check (retention_aed >= 0),
  advance_recovery_aed numeric(14,2) not null default 0 check (advance_recovery_aed >= 0),
  net_aed              numeric(14,2) not null default 0 check (net_aed >= 0),
  due_date             date,
  status               text not null default 'draft' check (status in ('draft','submitted','approved','rejected','paid')),
  requested_by         text,
  approved_by          text,
  approved_at          timestamptz,
  rejected_reason      text,
  paid_at              timestamptz,
  payment_method       text,
  notes                text,
  created_at           timestamptz not null default now(),
  constraint payment_requests_project_reference_key unique (project_id, reference)
);

-- Forward-compatibility guard: if an earlier draft of this migration created the
-- table without the advance-recovery column, add it without touching data.
alter table public.payment_requests
  add column if not exists advance_recovery_aed numeric(14,2) not null default 0;

comment on table public.payment_requests is
  'Project-level payment requests for subcontractors/suppliers with approval, rejection and payment workflow (scripts/modules/payment-requests.js).';
comment on column public.payment_requests.reference is
  'Human-readable request number, unique per project: PR-001, PR-002, … derived from the highest trailing number already present.';
comment on column public.payment_requests.retention_aed is
  'Retention held on this request = round(amount_aed * retention_pct / 100, 2). Re-derived by trigger on writes that touch the inputs.';
comment on column public.payment_requests.advance_recovery_aed is
  'Advance payment recovered against this request (AED). Deducted from net payable.';
comment on column public.payment_requests.net_aed is
  'Net payable = round(amount_aed - retention_aed - advance_recovery_aed, 2); never negative.';
comment on column public.payment_requests.approved_by is
  'Name (profiles.name) of the director/controller who approved the request.';
comment on column public.payment_requests.rejected_reason is
  'Mandatory reason captured by the module when a submitted request is rejected.';

-- ----------------------------------------------------------------------------
-- 2. Indexes (the unique constraint already indexes project_id + reference)
-- ----------------------------------------------------------------------------
create index if not exists payment_requests_project_created_idx
  on public.payment_requests (project_id, created_at desc);

create index if not exists payment_requests_project_status_idx
  on public.payment_requests (project_id, status);

-- Ageing / overdue queries: due_date NULL rows are excluded from the partial index.
create index if not exists payment_requests_project_due_idx
  on public.payment_requests (project_id, due_date)
  where due_date is not null;

create index if not exists payment_requests_party_idx
  on public.payment_requests (party_id);

-- ----------------------------------------------------------------------------
-- 3. Server-side arithmetic guard (keeps stored retention/net exact even for
--    direct PostgREST writes that bypass the module)
-- ----------------------------------------------------------------------------
create or replace function public.payment_requests_compute_amounts()
returns trigger
language plpgsql
as $$
begin
  new.amount_aed := round(coalesce(new.amount_aed, 0), 2);
  new.retention_pct := round(coalesce(new.retention_pct, 0), 2);
  new.retention_aed := round(coalesce(new.amount_aed, 0) * coalesce(new.retention_pct, 0) / 100.0, 2);
  new.advance_recovery_aed := round(coalesce(new.advance_recovery_aed, 0), 2);
  new.net_aed := round(coalesce(new.amount_aed, 0) - new.retention_aed - new.advance_recovery_aed, 2);
  if new.net_aed < 0 then
    raise exception 'payment request net amount cannot be negative (amount %, retention %, advance recovery %)',
      new.amount_aed, new.retention_aed, new.advance_recovery_aed
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payment_requests_compute_amounts on public.payment_requests;
create trigger trg_payment_requests_compute_amounts
  before insert or update of amount_aed, retention_pct, advance_recovery_aed
  on public.payment_requests
  for each row execute function public.payment_requests_compute_amounts();

-- ----------------------------------------------------------------------------
-- 4. Shared role helper (create or replace — identical definition in each
--    module migration; safe to re-run in any order)
-- ----------------------------------------------------------------------------
create or replace function public.sf_current_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- 5. Row-level security
-- ----------------------------------------------------------------------------
alter table public.payment_requests enable row level security;

-- Read: any signed-in user. The module view itself is gated to
-- director/controller/super by its view registration; lead users cannot open it.
drop policy if exists payment_requests_select on public.payment_requests;
create policy payment_requests_select on public.payment_requests
  for select to authenticated
  using (true);

-- Raise / submit: directors, controllers and superintendents.
drop policy if exists payment_requests_insert on public.payment_requests;
create policy payment_requests_insert on public.payment_requests
  for insert to authenticated
  with check (public.sf_current_role() in ('director','controller','super'));

-- Approve / reject / pay / edit: same role set at the database layer. The UI
-- narrows approve/reject/pay/edit/delete to director + controller (canManage()).
drop policy if exists payment_requests_update on public.payment_requests;
create policy payment_requests_update on public.payment_requests
  for update to authenticated
  using (public.sf_current_role() in ('director','controller','super'))
  with check (public.sf_current_role() in ('director','controller','super'));

drop policy if exists payment_requests_delete on public.payment_requests;
create policy payment_requests_delete on public.payment_requests
  for delete to authenticated
  using (public.sf_current_role() in ('director','controller','super'));

grant select, insert, update, delete on public.payment_requests to authenticated;
