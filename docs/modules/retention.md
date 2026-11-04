# Retention module — project retention releases

Owner: modules3. Contract: [`CONTRACT.md`](CONTRACT.md).

- Module: [`scripts/modules/retention.js`](../../scripts/modules/retention.js) (one self-contained IIFE, no `app.js` edits)
- Migration: [`supabase/migrations/202611050003_phase3.sql`](../../supabase/migrations/202611050003_phase3.sql) (owned by db-engineer; also creates the subcontractor certificates table + `sf_retention_open` RPC)
- Checks: [`tools/checks/retention.mjs`](../../tools/checks/retention.mjs) — `node tools/checks/retention.mjs`
- View: `retention` (sidebar → **project** section, icon 💠), roles `director` / `controller`.

Retention is withheld from each certified/paid progress billing. This view shows
the per-project position — total retained, released to date, and the open
(unreleased) balance — and lets a **Project Director** record a retention release
with a mandatory reason. Controllers can view the position and history but may
not release.

---

## 1. Install (one time)

Run the migration in the Supabase SQL editor (or `supabase db push`):

```
supabase/migrations/202611050003_phase3.sql
```

It must be idempotent (`create table if not exists`, `create or replace function`,
`drop policy if exists` before each `create policy`). Until it is run, the
Retention view shows the migration filename plus the exact PostgREST error.

Rollback instructions are in the migration header.

---

## 2. Data model

### `public.retention_releases`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `default gen_random_uuid()` |
| `project_id` | `uuid` | → `projects(id)` **on delete cascade** |
| `amount_aed` | `numeric(14,2)` | not null, `check (amount_aed > 0)` |
| `release_date` | `date` | not null, `default current_date` |
| `released_by` | `text` | actor name |
| `reason` | `text` | mandatory at the application layer |
| `created_at` | `timestamptz` | `default now()` |

RLS (per the phase-3 plan): `select` authenticated; `insert`/`update`/`delete`
director/controller.

---

## 3. Retention math

```
total_retained = Σ progress_billings.retention_amount  (status = certified | paid)
released       = Σ retention_releases.amount_aed       (for the project)
open           = total_retained − released
```

The module reads `SF.data.state.billings` for the retained side (already mapped
by `app.js` from `progress_billings`) and queries `retention_releases` with
`SF.db.selectStrict` for the released side. This mirrors the migration RPC
`public.sf_retention_open(p_project)`.

---

## 4. Behaviour

- **Position** — three KPI cards (total retained, released, open) plus a release
  history table (date, amount, released by, reason).
- **Record release** (Director only) — `SF.ui.openFormModal` with amount + reason.
  Validation runs inside `release()`: `0 < amount <= open` and a non-empty reason.
  The write goes through `SF.db.insert('retention_releases', …)` with
  `release_date = today`, `released_by = SF.user.name`.
- **Migration hint** — when `selectStrict('retention_releases', …)` returns an
  error, the view shows the migration filename and the PostgREST message.
- **No project** — project-scoped view shows the "Select a project" empty state.

---

## 5. Public API — `window.SF_modules.retention`

All members are defensive and never throw synchronously; `release()` returns a
Promise that never rejects (`{ ok, row | error }`).

| Member | Signature | Returns |
|---|---|---|
| `open` | `open()` | `number` — current `totalRetained − released` (cache) |
| `released` | `released()` | `number` — sum of cached `retention_releases.amount_aed` |
| `release` | `release(amount, reason)` | `Promise<{ ok, row | error }>` — validates and inserts |
| `list` | `list()` | array of cached release rows (copy) |
| `totalRetained` | `totalRetained()` | `number` — retained from certified/paid billings |

---

## 6. i18n

EN + AR via a local `L` dictionary with English fallback; the active language is
read from `SF.language`. All labels are escaped with `SF.helpers.esc`.

---

## 7. Testing

`node tools/checks/retention.mjs` runs:

1. **Static** — `node --check`; greps for the view registration (id `retention`,
   project nav, 💠 icon, `director`/`controller` roles), the public API keys,
   `selectStrict('retention_releases', …)`, `SF.db.insert('retention_releases'`
   and the release validation (`amount`, `reason`); SQL-idempotency greps of the
   phase-3 migration for `retention_releases` (skipped with a note if the file is
   not on disk).
2. **Testkit** — once `tools/lib/mock-supabase.mjs` mirrors `retention_releases`,
   it boots the real app headless and asserts: the view renders, the
   open/released math matches seeded billings + releases, and `release()` enforces
   `amount <= open` and a non-empty reason. If the mock lacks the table, the
   testkit step prints `skipped (mock not ready)` and exits 0.
