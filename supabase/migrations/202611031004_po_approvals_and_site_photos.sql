-- Forgesite: PO approval metadata + site-report photo storage
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL -> New query).
-- Safe to re-run: every statement is idempotent.
--
-- What it does
--   1. Records WHO approved/rejected BOQ items, POs (materials), change orders and
--      expenses, and when, plus a rejection reason. Before this the app only stored
--      status='approved'|'rejected', so the signatory lived only in the audit trail.
--   2. Ensures site_reports.photos is a JSONB array (the app now stores storage paths,
--      e.g. [{"name":"IMG_1.jpg","path":"<project>/site-reports/<id>/..."}]).
--   3. Ensures the private "siteforge-files" storage bucket exists with policies that
--      let signed-in users read and let directors/controllers/supers write.
--
-- Rollback (optional): the added columns can be dropped with
--   alter table public.materials drop column if exists approved_by, ... ;
-- Removing them only reverts the UI extras; no existing data is modified.

-- ---------------------------------------------------------------------------
-- 1. Approval metadata (idempotent)
-- ---------------------------------------------------------------------------
alter table public.boq_items        add column if not exists approved_by text;
alter table public.boq_items        add column if not exists approved_at timestamptz;
alter table public.boq_items        add column if not exists rejection_reason text;

alter table public.materials        add column if not exists approved_by text;
alter table public.materials        add column if not exists approved_at timestamptz;
alter table public.materials        add column if not exists rejection_reason text;

alter table public.change_orders    add column if not exists approved_by text;
alter table public.change_orders    add column if not exists approved_at timestamptz;
alter table public.change_orders    add column if not exists rejection_reason text;

alter table public.company_expenses add column if not exists approved_by text;
alter table public.company_expenses add column if not exists approved_at timestamptz;
alter table public.company_expenses add column if not exists rejection_reason text;

alter table public.timesheets       add column if not exists approved_by text;
alter table public.timesheets       add column if not exists approved_at timestamptz;
alter table public.timesheets       add column if not exists rejection_reason text;

-- Fast lookup for the approvals queue (pending per project).
create index if not exists materials_project_status_idx     on public.materials(project_id, status);
create index if not exists boq_items_project_status_idx     on public.boq_items(project_id, status);
create index if not exists change_orders_project_status_idx on public.change_orders(project_id, status);

-- ---------------------------------------------------------------------------
-- 2. Site report photos
-- ---------------------------------------------------------------------------
alter table public.site_reports add column if not exists photos jsonb default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- 3. Storage bucket + policies for report/drawing/logo uploads
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('siteforge-files', 'siteforge-files', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'sf_files_select'
  ) then
    create policy sf_files_select on storage.objects
      for select to authenticated
      using (bucket_id = 'siteforge-files');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'sf_files_insert'
  ) then
    create policy sf_files_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'siteforge-files'
        and exists (
          select 1 from public.profiles p
          where p.id = auth.uid() and p.role in ('director', 'controller', 'super')
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'sf_files_update'
  ) then
    create policy sf_files_update on storage.objects
      for update to authenticated
      using (
        bucket_id = 'siteforge-files'
        and exists (
          select 1 from public.profiles p
          where p.id = auth.uid() and p.role in ('director', 'controller', 'super')
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'sf_files_delete'
  ) then
    create policy sf_files_delete on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'siteforge-files'
        and exists (
          select 1 from public.profiles p
          where p.id = auth.uid() and p.role in ('director', 'controller', 'super')
        )
      );
  end if;
end $$;

comment on column public.site_reports.photos is
  'Array of {name, path, size} objects stored in the siteforge-files bucket; legacy rows may contain {name, data}.';
