-- ============================================================================
-- 202611031002_finance_statements.sql
-- SiteForge ERP — company-level Financial Accounts (AR / AP / balance sheet /
-- P&L) opening-balance settings.
--
-- Purpose
--   Creates public.finance_settings, the only table the Financial Accounts
--   module (scripts/modules/finance-statements.js) persists. Everything else in
--   the module is DERIVED from existing operational tables (progress_billings,
--   payments, materials, timesheets, company_expenses, company_budget_lines,
--   project_parties and, when installed, payment_requests).
--
--   One row per (company_id, fiscal_year) stores the opening balances the
--   balance sheet starts from:
--     opening_cash_aed   — cash on hand at the start of the fiscal year
--     opening_equity_aed — book equity at the start of the fiscal year
--   The module works with AED 0 defaults when this table (or the row) is
--   missing, so the migration is optional for the module to render.
--
-- Who should run it
--   The project owner / Supabase admin, once, in the Supabase SQL editor (or
--   via `supabase db push`). Safe to run more than once: every statement is
--   idempotent and no existing table, column, function or policy is modified.
--
-- Rollback (manual; this migration never drops anything on its own)
--   drop policy if exists finance_settings_select on public.finance_settings;
--   drop policy if exists finance_settings_insert on public.finance_settings;
--   drop policy if exists finance_settings_update on public.finance_settings;
--   drop policy if exists finance_settings_delete on public.finance_settings;
--   drop table if exists public.finance_settings;
--   (public.sf_current_role() is shared by the other module migrations — leave
--    it in place when rolling this one back.)
--
-- Notes
--   * gen_random_uuid() is built into PostgreSQL 13+; Supabase projects are
--     PG15+, so no `create extension pgcrypto` is required.
--   * Manager roles are 'director' and 'controller' (docs/modules/CONTRACT.md).
--   * finance_settings is company-scoped, not project-scoped: the module
--     aggregates every project, so there is no project_id column here.
--   * created_at is kept, updated_at is not required by the contract, and the
--     module sends every column explicitly so a dropped column stays harmless.
-- ============================================================================

create table if not exists public.finance_settings (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid references public.companies(id) on delete cascade,
  fiscal_year        integer,
  opening_cash_aed   numeric(14,2) not null default 0,
  opening_equity_aed numeric(14,2) not null default 0,
  notes              text,
  created_at         timestamptz not null default now(),
  constraint finance_settings_company_year_key unique (company_id, fiscal_year)
);

comment on table public.finance_settings is
  'SiteForge Financial Accounts: opening cash/equity per company and fiscal year. Derived statements aggregate all projects.';
comment on column public.finance_settings.opening_cash_aed is
  'Cash and cash equivalents at the start of the fiscal year (AED). Defaults to 0 when no row exists.';
comment on column public.finance_settings.opening_equity_aed is
  'Book equity at the start of the fiscal year (AED). Used to split derived equity into opening equity + implied current-period result.';

create index if not exists finance_settings_company_idx
  on public.finance_settings (company_id, fiscal_year);

-- Shared role helper (contract §4): safe to run in every module migration.
create or replace function public.sf_current_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

-- RLS: read for any signed-in user, write only for the finance managers.
alter table public.finance_settings enable row level security;

drop policy if exists finance_settings_select on public.finance_settings;
create policy finance_settings_select on public.finance_settings
  for select to authenticated using (true);

drop policy if exists finance_settings_insert on public.finance_settings;
create policy finance_settings_insert on public.finance_settings
  for insert to authenticated
  with check (public.sf_current_role() in ('director','controller'));

drop policy if exists finance_settings_update on public.finance_settings;
create policy finance_settings_update on public.finance_settings
  for update to authenticated
  using (public.sf_current_role() in ('director','controller'))
  with check (public.sf_current_role() in ('director','controller'));

drop policy if exists finance_settings_delete on public.finance_settings;
create policy finance_settings_delete on public.finance_settings
  for delete to authenticated
  using (public.sf_current_role() in ('director','controller'));

grant select, insert, update, delete on public.finance_settings to authenticated;
