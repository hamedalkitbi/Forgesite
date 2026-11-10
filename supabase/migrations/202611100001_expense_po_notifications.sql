-- ============================================================================
-- 202611100001_expense_po_notifications.sql
-- SiteForge ERP — company-expense fix + PO references + submission notifications
--
-- Related specs / migrations:
--   docs/modules/phase2-plan.md (period close + SLA escalation)
--   docs/modules/CONTRACT.md    (migration conventions, manager roles)
--   202611050001_phase1_accountability.sql
--   202611050002_phase2_workflow.sql   <-- introduced the regression fixed here
--   202611050003_phase3.sql
--
-- Purpose
--   1. FIX: every INSERT/UPDATE on public.company_expenses failed at runtime
--      with `record "new" has no field "company_id"`.
--      Root cause: 202611050002_phase2_workflow.sql redefined
--      public.sf_guard_closed_period() so that its company_expenses branch
--      reads NEW.company_id, but nothing in the repo ever created that column.
--      Because the guard is a BEFORE INSERT OR UPDATE trigger, it raised
--      before the row was written, so no company expense could be saved. The
--      same phase-2 migration's sf_escalate_overdue() also selects
--      e.company_id from company_expenses, so the post-login escalation call
--      was failing as well (it starts working again once the column exists).
--      This file adds the column and re-creates the guard so that the company
--      is resolved defensively: a missing column can never raise again.
--   2. Company-expense PO / bill references: po_number, po_date and bill_path
--      (the app already reads/writes bill_path when a bill photo is attached).
--   3. sf_notify_submission() + AFTER triggers on materials,
--      company_expenses and site_reports: directors/controllers receive one
--      notifications row per submission awaiting their attention. Notifications
--      are best-effort only (see sections 3–4) and never block the write.
--
-- Who runs it
--   The site owner/operator, by hand, in the Supabase SQL editor (this project
--   has no supabase CLI / psql / DB credentials). Run it AFTER the previous
--   migrations 202611050001 → 202611050002 → 202611050003. It is idempotent
--   and safe to re-run.
--
-- What it creates / alters
--   1. company_expenses.company_id uuid references public.companies(id).
--   2. company_expenses.po_number, company_expenses.po_date,
--      company_expenses.bill_path.
--   3. Functions: sf_guard_closed_period (replaced), sf_notify_submission (new).
--   4. AFTER triggers: trg_notify_materials (INSERT OR UPDATE),
--      trg_notify_company_expenses (INSERT OR UPDATE),
--      trg_notify_site_reports (INSERT).
--   5. Lookup indexes on company_expenses(company_id) and (po_number).
--
-- Out of scope (intentionally NOT touched by this migration):
--   app code, RLS policies on existing tables, the phase-2 period-close
--   triggers/policies, and every table not listed above. In particular
--   sf_escalate_overdue(), sf_assert_period_open() and the approval RPCs are
--   NOT redefined — they are already correct once company_id exists.
--
-- Idempotency
--   add column if not exists / create or replace function / drop trigger if
--   exists + create trigger / create index if not exists / guarded backfill /
--   comment on column — every statement is safe to re-run. The last executable
--   statement is `notify pgrst, 'reload schema'` so PostgREST picks the new
--   columns up immediately (otherwise the app's company_id write would be
--   rejected from the stale schema cache and silently dropped).
--
-- Notes
--   * companies is read-only here (FK target + the single-company backfill).
--   * manager roles are 'director' and 'controller' (docs/modules/CONTRACT.md);
--     only rows in public.profiles with those roles receive notifications.
--   * The notifications table is probed via information_schema exactly like
--     sf_escalate_overdue() does, so an older/simpler base schema (only
--     title/body/is_read/created_at) still works.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. company_expenses.company_id — the missing column behind the bug
-- ----------------------------------------------------------------------------

-- The app will start sending company_id on every company expense. Adding it
-- here also fixes sf_escalate_overdue() (it selects e.company_id) and lets the
-- period-close guard resolve a company for expenses again.
-- NOTE: if the column already exists (multi-company deployments), ADD COLUMN IF
-- NOT EXISTS is a no-op and this migration leaves the existing definition
-- (including any FK) untouched.
alter table public.company_expenses
  add column if not exists company_id uuid references public.companies(id);

comment on column public.company_expenses.company_id is
  'Owning company for this expense; used by period-close and SLA escalation. NULL = cannot be determined (legacy row).';

-- Backfill only when it is unambiguous: exactly one company exists. On a
-- multi-company database the column stays NULL and no data is guessed.
--
-- Closed periods: the existing trg_guard_closed_period_company_expenses trigger
-- is a BEFORE UPDATE guard, and sf_assert_period_open() raises CLOSED_PERIOD for
-- a frozen month. Writing company_id on such a historical row would abort the
-- whole migration, so rows whose accounting period is closed are skipped here
-- (they stay NULL, which the defensive guard below treats as "cannot
-- determine"). This makes the backfill re-runnable after periods are reopened.
do $$
declare
  v_company_count int;
  v_company_id    uuid;
begin
  select count(*) into v_company_count from public.companies;

  if v_company_count <> 1 then
    raise notice 'company_expenses.company_id backfill skipped: % companies exist (needs exactly 1).', v_company_count;
    return;
  end if;

  select c.id into v_company_id from public.companies c limit 1;

  -- closed_periods is created by 202611050002 (run required earlier); the
  -- to_regclass guard keeps this file runnable even on a base-only schema.
  if to_regclass('public.closed_periods') is null then
    update public.company_expenses
       set company_id = v_company_id
     where company_id is null;
  else
    update public.company_expenses e
       set company_id = v_company_id
     where e.company_id is null
       and not exists (
         select 1
           from public.closed_periods cp
          where cp.company_id = v_company_id
            and cp.period = to_char(e.expense_date, 'YYYY-MM')
       );
  end if;

  raise notice 'company_expenses.company_id backfilled from the single company (%) — open periods only.', v_company_id;
end
$$;

-- ----------------------------------------------------------------------------
-- 2. Company-expense PO / bill references
-- ----------------------------------------------------------------------------

-- PO number this expense belongs to (free text, mirrors materials.po_number; no
-- FK because POs are per-project rows in materials, not a master table).
alter table public.company_expenses
  add column if not exists po_number text;

comment on column public.company_expenses.po_number is
  'Purchase-order reference copied/linked from materials.po_number; optional.';

-- Date printed on the PO (informational; the accounting date is expense_date).
alter table public.company_expenses
  add column if not exists po_date date;

comment on column public.company_expenses.po_date is
  'Date of the purchase order referenced by po_number; optional/informational.';

-- Storage path of the scanned bill copy (the app already sends this when the
-- user attaches a bill photo; declared here so the write stops being dropped).
alter table public.company_expenses
  add column if not exists bill_path text;

comment on column public.company_expenses.bill_path is
  'Storage path of the scanned bill/receipt (siteforge-files bucket); optional.';

-- ----------------------------------------------------------------------------
-- 3. Functions
-- ----------------------------------------------------------------------------

-- BEFORE INSERT OR UPDATE guard on the dated tables (replaces the phase-2
-- definition). Maps TG_TABLE_NAME to its date column, resolves the company and
-- asserts the period is open:
--   timesheets         -> work_date     (company via project_id -> projects.company_id)
--   company_expenses   -> expense_date  (company via company_id)
--   payments           -> paid_date (fallback due_date) (company via project_id)
--   payroll_batches    -> period 'YYYY-MM' -> first of month (company via project_id)
--   progress_billings  -> period_from   (company via project_id)
--   materials          -> invoice_date  (company via project_id)
--
-- FIX: the company_expenses branch used to read NEW.company_id directly. If the
-- column is absent the trigger raises `record "new" has no field "company_id"`
-- on EVERY insert/update, before the row is written. Resolving the value through
-- to_jsonb(NEW) returns NULL for a missing column instead of raising; NULL means
-- "company cannot be determined", which the guard already treated as a pass
-- (a NULL company_id could never match a closed period anyway). Every other
-- branch keeps the exact phase-2 behaviour.
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
    -- Defensive resolution: works whether or not the column exists, never
    -- raises "record new has no field company_id".
    v_company_id := (to_jsonb(NEW) ->> 'company_id')::uuid;
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

-- Best-effort "you have something to review" notification for a submission.
-- Called by the AFTER triggers in section 4 on materials / company_expenses /
-- site_reports. Contract:
--   * One notifications row per recipient (profiles.role in director/controller),
--     skipping the submitter (profiles.name = NEW.created_by).
--   * The notification text and dedupe key are built per table:
--        materials:<id>:pending, company_expenses:<id>:pending,
--        site_reports:<id>:submitted
--   * notifications' optional columns (user_id, type, notif_dedupe, is_read,
--     created_at) are probed via information_schema exactly like
--     sf_escalate_overdue(), then inserted with dynamic SQL.
--   * The whole body runs inside a nested block with `exception when others
--     then return new`, so ANY notification failure (missing column/table, odd
--     data, RLS, duplicate dedupe, ...) is swallowed: a notification must never
--     roll back the business write.
create or replace function public.sf_notify_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_user    boolean;
  v_has_type    boolean;
  v_has_dedupe  boolean;
  v_has_read    boolean;
  v_has_created boolean;
  v_id          text;
  v_submitter   text;
  v_status      text;
  v_old_status  text;
  v_title       text;
  v_body        text;
  v_dedupe      text;
  v_amount      numeric(14,2);
  v_po          text;
  v_desc        text;
  v_paid_to     text;
  v_project_id  text;
  v_proj_code   text;
  v_report      text;
  v_photos      int;
  v_cols        text;
  v_vals        text;
  v_sql         text;
begin
  -- Guardrail: notifications are a courtesy, never a precondition.
  begin
    -- All reads go through to_jsonb(NEW) so that a column that is absent on a
    -- given deployment yields NULL instead of `record "new" has no field ...`.
    v_id        := coalesce(to_jsonb(NEW) ->> 'id', '');
    v_submitter := nullif(to_jsonb(NEW) ->> 'created_by', '');

    -- ------------------------------------------------------------------
    -- Per-table: decide whether this is a submission, then build title/body
    -- and the dedupe key.
    -- ------------------------------------------------------------------
    if TG_TABLE_NAME = 'materials' then
      -- POs only notify when they enter the approval queue.
      v_status := coalesce(to_jsonb(NEW) ->> 'status', '');
      if v_status <> 'pending' then
        return NEW;
      end if;
      if TG_OP = 'UPDATE' then
        v_old_status := coalesce(to_jsonb(OLD) ->> 'status', '');
        if v_old_status = v_status then
          return NEW;   -- still pending: not a new submission
        end if;
      end if;

      v_po     := nullif(to_jsonb(NEW) ->> 'po_number', '');
      v_desc   := coalesce(nullif(to_jsonb(NEW) ->> 'description', ''), 'material');
      v_amount := round(
        coalesce((to_jsonb(NEW) ->> 'quantity')::numeric, 0)
        * coalesce((to_jsonb(NEW) ->> 'unit_cost_aed')::numeric,
                   (to_jsonb(NEW) ->> 'baseline_cost_aed')::numeric, 0),
        2);
      v_title  := 'Purchase order awaiting approval';
      v_body   := 'Purchase order ' || coalesce(v_po, '(no number)') || ' — ' || v_desc
               || ' · AED ' || to_char(v_amount, 'FM999,999,999,999,990.00');
      v_dedupe := 'materials:' || v_id || ':pending';

    elsif TG_TABLE_NAME = 'company_expenses' then
      -- Company expenses only notify when they enter the approval queue
      -- (managers insert them as 'approved' and never notify themselves).
      v_status := coalesce(to_jsonb(NEW) ->> 'status', '');
      if v_status <> 'pending' then
        return NEW;
      end if;
      if TG_OP = 'UPDATE' then
        v_old_status := coalesce(to_jsonb(OLD) ->> 'status', '');
        if v_old_status = v_status then
          return NEW;   -- still pending: not a new submission
        end if;
      end if;

      v_amount  := coalesce((to_jsonb(NEW) ->> 'amount')::numeric, 0);
      v_po      := nullif(to_jsonb(NEW) ->> 'po_number', '');
      v_desc    := coalesce(
                     nullif(to_jsonb(NEW) ->> 'description', ''),
                     nullif(to_jsonb(NEW) ->> 'category', ''),
                     'expense');
      v_paid_to := nullif(to_jsonb(NEW) ->> 'paid_to', '');
      v_title   := 'Company expense awaiting approval';
      v_body    := v_desc;
      if v_paid_to is not null then
        v_body := v_body || ' — paid to ' || v_paid_to;
      end if;
      v_body := v_body || ' · AED ' || to_char(v_amount, 'FM999,999,999,999,990.00');
      if v_po is not null then
        -- po_number values in this app already carry their 'PO-' prefix.
        v_body := v_body || ' · ' || v_po;
      end if;
      v_dedupe := 'company_expenses:' || v_id || ':pending';

    elsif TG_TABLE_NAME = 'site_reports' then
      -- The trigger is AFTER INSERT only; the TG_OP test is belt and braces.
      if TG_OP <> 'INSERT' then
        return NEW;
      end if;

      v_report := coalesce(nullif(to_jsonb(NEW) ->> 'title', ''), 'Site report');
      v_title  := 'New site report submitted';
      v_project_id := nullif(to_jsonb(NEW) ->> 'project_id', '');
      if v_project_id is not null then
        select coalesce(nullif(p.code, ''), p.name)
          into v_proj_code
          from public.projects p
         where p.id::text = v_project_id
         limit 1;
      end if;
      v_photos := 0;
      if jsonb_typeof(to_jsonb(NEW) -> 'photos') = 'array' then
        v_photos := jsonb_array_length(to_jsonb(NEW) -> 'photos');
      end if;
      v_body := '"' || v_report || '"';
      if v_proj_code is not null then
        v_body := v_body || ' · project ' || v_proj_code;
      end if;
      if v_photos > 0 then
        v_body := v_body || ' · ' || v_photos || ' photo(s)';
      end if;
      v_dedupe := 'site_reports:' || v_id || ':submitted';

    else
      -- Not one of the three attached tables: do nothing.
      return NEW;
    end if;

    -- ------------------------------------------------------------------
    -- Probe the deployed notifications schema (same approach as
    -- sf_escalate_overdue). title/body are assumed; the rest are optional.
    -- ------------------------------------------------------------------
    select exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'notifications'
                     and column_name = 'user_id')
      into v_has_user;
    select exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'notifications'
                     and column_name = 'type')
      into v_has_type;
    select exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'notifications'
                     and column_name = 'notif_dedupe')
      into v_has_dedupe;
    select exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'notifications'
                     and column_name = 'is_read')
      into v_has_read;
    select exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'notifications'
                     and column_name = 'created_at')
      into v_has_created;

    -- Idempotency is provided by the pending-transition check above (an UPDATE
    -- that leaves the row pending returns early), NOT by scanning existing
    -- notifications: a rejected -> pending re-submission SHOULD notify again,
    -- while pending -> pending saves never reach this point. The dedupe key is
    -- still written to notif_dedupe when that column exists, so downstream
    -- consumers (reports, future cron jobs) can tell submissions apart.

    -- ------------------------------------------------------------------
    -- Insert one row per manager, skipping the submitter, with dynamic SQL so
    -- optional columns are omitted cleanly.
    -- ------------------------------------------------------------------
    v_cols := '';
    v_vals := '';
    if v_has_user then
      v_cols := v_cols || 'user_id, ';
      v_vals := v_vals || 'p.id, ';
    end if;
    if v_has_type then
      v_cols := v_cols || 'type, ';
      v_vals := v_vals || quote_literal('submission') || ', ';
    end if;
    if v_has_dedupe then
      v_cols := v_cols || 'notif_dedupe, ';
      v_vals := v_vals || quote_literal(coalesce(v_dedupe, '')) || ', ';
    end if;
    if v_has_read then
      v_cols := v_cols || 'is_read, ';
      v_vals := v_vals || 'false, ';
    end if;
    v_cols := v_cols || 'title, body';
    v_vals := v_vals || quote_literal(coalesce(v_title, 'Submission'))
                    || ', ' || quote_literal(coalesce(v_body, ''));
    if v_has_created then
      v_cols := v_cols || ', created_at';
      v_vals := v_vals || ', now()';
    end if;

    v_sql := 'insert into public.notifications (' || v_cols || ') select ' || v_vals
          || ' from public.profiles p'
          || ' where p.role in (''director'', ''controller'')'
          || ' and ($1::text is null or p.name is distinct from $1::text)';
    execute v_sql using v_submitter;

  exception when others then
    -- Never surface a notification failure to the business write.
    raise warning 'sf_notify_submission skipped on % (%): %',
      tg_table_name, sqlstate, sqlerrm;
    return NEW;
  end;

  return NEW;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Submission-notification triggers
--    No WHEN clause and no UPDATE OF: a WHEN condition on a trigger that also
--    fires for INSERT may not reference OLD (an INSERT row has no old image),
--    so the "did it just become pending?" test lives inside the plpgsql body
--    behind a TG_OP guard. drop trigger if exists keeps the file re-runnable.
-- ----------------------------------------------------------------------------
drop trigger if exists trg_notify_materials on public.materials;
create trigger trg_notify_materials
  after insert or update on public.materials
  for each row execute function public.sf_notify_submission();

drop trigger if exists trg_notify_company_expenses on public.company_expenses;
create trigger trg_notify_company_expenses
  after insert or update on public.company_expenses
  for each row execute function public.sf_notify_submission();

drop trigger if exists trg_notify_site_reports on public.site_reports;
create trigger trg_notify_site_reports
  after insert on public.site_reports
  for each row execute function public.sf_notify_submission();

-- ----------------------------------------------------------------------------
-- 5. Lookup indexes (the guard/escalation filter by company; the app searches
--    expenses by PO number in the PO workflow)
-- ----------------------------------------------------------------------------
create index if not exists company_expenses_company_id_idx
  on public.company_expenses (company_id);

create index if not exists company_expenses_po_number_idx
  on public.company_expenses (po_number);

-- ----------------------------------------------------------------------------
-- 6. Refresh PostgREST's schema cache.
--    Without this the app would still get
--    "Could not find the 'company_id' column ... in the schema cache" for the
--    new columns until the cache expires, and its dropped-column fallback would
--    silently skip the very value this migration adds.
-- ----------------------------------------------------------------------------
notify pgrst, 'reload schema';

-- ============================================================================
-- Run order / aftercare
--
--   * Apply this file by hand in the Supabase SQL editor, AFTER
--     202611050001_accountability … 202611050003_phase3. It is idempotent:
--     re-running skips the column adds, leaves already-backfilled rows alone,
--     replaces the same two functions and recreates the same three triggers.
--
--   * What it fixes:
--       - company-expense INSERT/UPDATE no longer raises
--         'record "new" has no field "company_id"' (missing column + a guard
--         function that assumed it);
--       - sf_escalate_overdue() (called after login) can read
--         company_expenses.company_id again;
--       - expenses carry a PO reference (po_number, po_date) and a bill copy
--         (bill_path);
--       - directors/controllers get a notifications row when a PO, a company
--         expense or a site report is submitted.
--
--   * Degradation: notifications are a convenience. The app re-reads them with
--     `supabase.from('notifications').select('*')` on load and tolerates an
--     older/simpler notifications table; and the trigger function swallows any
--     notification error, so a missing notifications column or a data problem
--     can never roll back the PO / expense / site-report write.
--
--   * Rollback (optional, in this order):
--       drop trigger if exists trg_notify_materials on public.materials;
--       drop trigger if exists trg_notify_company_expenses on public.company_expenses;
--       drop trigger if exists trg_notify_site_reports on public.site_reports;
--       drop function if exists public.sf_notify_submission();
--       -- Re-running 202611050002 restores its (broken) guard definition.
--       alter table public.company_expenses drop column if exists bill_path;
--       alter table public.company_expenses drop column if exists po_date;
--       alter table public.company_expenses drop column if exists po_number;
--       -- Keep company_id: dropping it re-introduces the original bug.
-- ============================================================================
