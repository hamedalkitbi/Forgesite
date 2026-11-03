-- Forgesite: approval columns, missing status columns, site-report photo storage
--
-- Run this ONCE in the Supabase SQL editor (Dashboard -> SQL -> New query).
-- Safe to re-run: every statement is idempotent and no data is deleted.
--
-- What it does
--   1. Adds the `status` column to tables that may predate it (materials / POs,
--      BOQ items, change orders, timesheets, company expenses). The app has always
--      sent `status` on insert and read it for the approvals queue, but on an older
--      database the column was missing and the app's unknown-column tolerance
--      silently dropped it — which is why PO/CO approvals never persisted.
--      Existing rows are backfilled to 'approved' (they are historical) so the
--      approval queue only fills with new work.
--   2. Records WHO approved/rejected BOQ items, POs (materials), change orders and
--      expenses, and when, plus a rejection reason.
--   3. Ensures site_reports.photos is a JSONB array (the app stores storage paths,
--      e.g. [{"name":"IMG_1.jpg","path":"<project>/site-reports/<id>/..."}]).
--   4. Ensures the private "siteforge-files" storage bucket exists with policies that
--      let signed-in users read and let directors/controllers/supers write.
--
-- Rollback (optional):
--   alter table public.materials drop column if exists approved_by, ... ;
--   The status columns added here are harmless if left in place.
--
-- ---------------------------------------------------------------------------
-- 0. status columns (root cause of approvals never persisting)
-- ---------------------------------------------------------------------------
alter table public.materials         add column if not exists status text;
alter table public.boq_items         add column if not exists status text;
alter table public.change_orders     add column if not exists status text;
alter table public.timesheets        add column if not exists status text;
alter table public.company_expenses  add column if not exists status text;

-- Historical rows are treated as already certified.
update public.materials         set status = 'approved' where status is null;
update public.boq_items         set status = 'approved' where status is null;
update public.change_orders     set status = 'approved' where status is null;
update public.timesheets        set status = 'approved' where status is null;
update public.company_expenses  set status = 'approved' where status is null;

-- New rows created by the app always send an explicit status; these defaults only
-- apply to rows created outside the app (SQL/CSV/automation).
--   POs and change orders default to pending so nothing bypasses approval.
--   BOQ imports / timesheets / expenses default to approved (imports are done by
--   managers and would otherwise flood the queue line by line).
alter table public.materials         alter column status set default 'pending';
alter table public.change_orders     alter column status set default 'pending';
alter table public.boq_items         alter column status set default 'approved';
alter table public.timesheets        alter column status set default 'approved';
alter table public.company_expenses  alter column status set default 'approved';

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

-- Fast lookup for the approvals queue (pending per project). Safe now that
-- `status` is guaranteed to exist by section 0.
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

-- Ask PostgREST to pick up the new columns/tables immediately.
notify pgrst, 'reload schema';
