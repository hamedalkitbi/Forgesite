-- ============================================================================
-- 202611050003_phase3.sql
-- SiteForge ERP — Phase 3: retention release, subcontractor certificates,
-- management exceptions (DB portion only)
--
-- Authoritative spec: docs/modules/phase3-plan.md
--
-- Purpose
--   Persistence + server-side guards for the Phase 3 modules:
--   1. retention_releases — director/controller records a release of retained
--      funds against a project; amount must be positive.
--   2. subcontractor_certificates — measured BOQ line + supplier → certified
--      amount, with a lifecycle draft/certified/paid and a link to a generated
--      payment_requests row (request_type 'subcontractor').
--   3. sf_retention_open(p_project) — computes {total_retained, released, open}
--      from progress_billings.retention_amount (certified/paid) minus the
--      project's retention_releases. Feeds the retention + management dashboards.
--
-- What it creates / attaches
--   1. New tables: retention_releases, subcontractor_certificates.
--   2. Function: sf_retention_open.
--   3. RLS for both new tables: select authenticated; write director/controller.
--   4. Grants to `authenticated` (RLS narrows the actual access).
--   5. Lookup indexes on the columns the modules filter by.
--
-- Out of scope (intentionally NOT touched by this migration):
--   profiles, projects, companies, suppliers, boq_items, payment_requests and
--   progress_billings are read-only via FKs / lookups only — no columns, FKs,
--   triggers or policies are added to them here. NOTE: boq_item_id and
--   payment_request_id are plain TEXT (no FK) because boq_items.id and
--   payment_requests.id may be text/non-uuid in this deployment; the app joins
--   them by value.
--
-- Idempotency
--   create table if not exists / create or replace function / drop policy if
--   exists + create policy / create index if not exists. Ends with
--   notify pgrst reload schema.
--
-- Notes
--   * Reuses the shared helpers sf_current_role() / sf_current_user() defined
--     in 202611050001 — they are NOT redefined here.
--   * manager roles are 'director' and 'controller' (docs/modules/CONTRACT.md).
--   * progress_billings.retention_amount is summed for status IN ('certified',
--     'paid') per the plan (matches docs/modules/finance.md "certified
--     certificates" = certified OR paid).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New tables
-- ----------------------------------------------------------------------------

-- A release of retained funds against a project. Amount must be > 0; the app
-- enforces amount <= open (see sf_retention_open) before inserting.
create table if not exists public.retention_releases (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.projects(id) on delete cascade,
  amount_aed   numeric(14,2) not null check (amount_aed > 0),
  release_date date not null default current_date,
  released_by  text,
  reason       text,
  created_at   timestamptz default now()
);

-- Subcontractor measurement certificate: a BOQ line + supplier → certified
-- amount. `reference` is 'SC-0001' per project (uniqueness enforced by the app);
-- `period` is 'YYYY-MM'. `payment_request_id` links the generated payment request.
create table if not exists public.subcontractor_certificates (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid references public.projects(id) on delete cascade,
  supplier_id          uuid references public.suppliers(id) on delete set null,
  boq_item_id          text,               -- boq_items.id may be text in this deployment
  reference            text not null,      -- SC-0001 per project (app-enforced uniqueness)
  period               text,               -- 'YYYY-MM'
  measured_qty         numeric(14,2) not null check (measured_qty >= 0),
  rate_aed             numeric(14,2) not null,
  certified_amount_aed numeric(14,2) not null,
  status               text not null default 'draft'
                         check (status in ('draft','certified','paid')),
  certified_by         text,
  certified_at         timestamptz,
  payment_request_id   text,               -- linked payment_requests id (no FK)
  notes                text,
  created_at           timestamptz default now()
);

comment on table public.retention_releases is
  'Release of retained funds against a project; amount > 0 and <= open (enforced by the app).';
comment on table public.subcontractor_certificates is
  'Subcontractor measurement certificate (BOQ line + supplier) with draft/certified/paid lifecycle.';

-- ----------------------------------------------------------------------------
-- 1.1 Lookup indexes
-- ----------------------------------------------------------------------------
create index if not exists retention_releases_project_idx
  on public.retention_releases (project_id);

create index if not exists subcontractor_certificates_project_idx
  on public.subcontractor_certificates (project_id);

create index if not exists subcontractor_certificates_supplier_idx
  on public.subcontractor_certificates (supplier_id);

create index if not exists subcontractor_certificates_boq_item_idx
  on public.subcontractor_certificates (boq_item_id);

create index if not exists subcontractor_certificates_status_idx
  on public.subcontractor_certificates (status);

create index if not exists subcontractor_certificates_payment_request_idx
  on public.subcontractor_certificates (payment_request_id);

-- ----------------------------------------------------------------------------
-- 2. Functions
-- ----------------------------------------------------------------------------

-- Retention position for a project: total retained (certified/paid billings)
-- minus releases already made. Returns {"total_retained", "released", "open"}.
create or replace function public.sf_retention_open(p_project uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total_retained numeric(14,2);
  v_released       numeric(14,2);
  v_open           numeric(14,2);
begin
  select coalesce(sum(b.retention_amount), 0)
    into v_total_retained
    from public.progress_billings b
   where b.project_id = p_project
     and coalesce(b.status, 'draft') in ('certified', 'paid');

  select coalesce(sum(r.amount_aed), 0)
    into v_released
    from public.retention_releases r
   where r.project_id = p_project;

  v_open := coalesce(v_total_retained, 0) - coalesce(v_released, 0);

  return jsonb_build_object(
    'total_retained', coalesce(v_total_retained, 0),
    'released',       coalesce(v_released, 0),
    'open',           v_open
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Row-level security
-- ----------------------------------------------------------------------------

-- 3.1 retention_releases: read any authenticated user; write director/controller.
alter table public.retention_releases enable row level security;

drop policy if exists retention_releases_select on public.retention_releases;
create policy retention_releases_select on public.retention_releases
  for select to authenticated
  using (true);

drop policy if exists retention_releases_insert on public.retention_releases;
create policy retention_releases_insert on public.retention_releases
  for insert to authenticated
  with check (public.sf_current_role() in ('director', 'controller'));

drop policy if exists retention_releases_update on public.retention_releases;
create policy retention_releases_update on public.retention_releases
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller'))
  with check (public.sf_current_role() in ('director', 'controller'));

drop policy if exists retention_releases_delete on public.retention_releases;
create policy retention_releases_delete on public.retention_releases
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller'));

-- 3.2 subcontractor_certificates: read any authenticated user; write director/controller.
alter table public.subcontractor_certificates enable row level security;

drop policy if exists subcontractor_certificates_select on public.subcontractor_certificates;
create policy subcontractor_certificates_select on public.subcontractor_certificates
  for select to authenticated
  using (true);

drop policy if exists subcontractor_certificates_insert on public.subcontractor_certificates;
create policy subcontractor_certificates_insert on public.subcontractor_certificates
  for insert to authenticated
  with check (public.sf_current_role() in ('director', 'controller'));

drop policy if exists subcontractor_certificates_update on public.subcontractor_certificates;
create policy subcontractor_certificates_update on public.subcontractor_certificates
  for update to authenticated
  using (public.sf_current_role() in ('director', 'controller'))
  with check (public.sf_current_role() in ('director', 'controller'));

drop policy if exists subcontractor_certificates_delete on public.subcontractor_certificates;
create policy subcontractor_certificates_delete on public.subcontractor_certificates
  for delete to authenticated
  using (public.sf_current_role() in ('director', 'controller'));

-- ----------------------------------------------------------------------------
-- 4. Grants (RLS narrows the actual access)
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.retention_releases to authenticated;
grant select, insert, update, delete on public.subcontractor_certificates to authenticated;

-- Ask PostgREST to pick up the new tables/columns/functions immediately.
notify pgrst, 'reload schema';
