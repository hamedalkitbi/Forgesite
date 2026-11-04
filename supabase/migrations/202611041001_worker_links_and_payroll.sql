-- SiteForge: worker-linked timesheets + payroll/AP helper indexes
--
-- Run once in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- What it does
--   1. Links timesheets to the staff register (worker_id), so payroll can aggregate
--      approved overtime per worker instead of matching on free-text names only.
--   2. Adds lookup indexes used by the unified payroll run and the IPC -> receivables
--      sync (payments matched by invoice_no).
--
-- Rollback:
--   drop index if exists public.timesheets_worker_idx;
--   drop index if exists public.timesheets_period_idx;
--   drop index if exists public.payments_invoice_no_idx;
--   alter table public.timesheets drop column if exists worker_id;

alter table public.timesheets
  add column if not exists worker_id uuid references public.workers(id) on delete set null;

create index if not exists timesheets_worker_idx on public.timesheets(worker_id);
create index if not exists timesheets_period_idx on public.timesheets(work_date);
create index if not exists payments_invoice_no_idx on public.payments(invoice_no);

notify pgrst, 'reload schema';
