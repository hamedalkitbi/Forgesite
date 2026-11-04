# Suppliers & Contractors module — company-level directory

Owner: suppliers feature. Contract: [`CONTRACT.md`](CONTRACT.md).

- Module: [`scripts/modules/suppliers.js`](../../scripts/modules/suppliers.js) (one self-contained IIFE, no `app.js` edits)
- Migration: [`supabase/migrations/202611050001_phase1_accountability.sql`](../../supabase/migrations/202611050001_phase1_accountability.sql) (owned by db-engineer; also creates the phase-1 approval tables)
- Checks: [`tools/checks/suppliers.mjs`](../../tools/checks/suppliers.mjs) — `node tools/checks/suppliers.mjs`
- View: `suppliers` (sidebar → **company** section, icon 🏢), roles `director` / `controller` only.

A company-wide master directory of suppliers and subcontractors, reused across
projects, parties, POs and payment requests. Managers list, add, edit, deactivate
and delete suppliers, and link each supplier to projects with a per-project
contract amount and reference.

---

## 1. Install (one time)

Run the migration in the Supabase SQL editor (or `supabase db push`):

```
supabase/migrations/202611050001_phase1_accountability.sql
```

It must be idempotent (`create table if not exists`, `create or replace function`,
`drop policy if exists` before each `create policy`). Until it is run, the
Suppliers view shows the migration filename plus the exact PostgREST error instead
of a blank page.

Rollback instructions are in the migration header.

---

## 2. Data model

### `public.suppliers` (company-level master)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `default gen_random_uuid()` |
| `company_id` | `uuid` | → `companies(id)` **on delete cascade** |
| `name` | `text` not null | display name; `lookup()` is case-insensitive on this |
| `kind` | `text` not null | `check (kind in ('supplier','subcontractor','both'))` |
| `trade` | `text` | trade / discipline (e.g. `CONC`, `ELEC`) |
| `trn` | `text` | tax registration number |
| `contact_person` | `text` | primary contact |
| `phone` | `text` | |
| `email` | `text` | |
| `address` | `text` | |
| `bank_name` | `text` | |
| `iban` | `text` | |
| `account_no` | `text` | |
| `payment_terms_days` | `int` | `default 30` |
| `vat_pct` | `numeric(5,2)` | `default 5` |
| `status` | `text` not null | `check (status in ('active','inactive','blocked'))`, default `active` |
| `created_by` | `text` | actor name |
| `created_at` | `timestamptz` | `default now()` |
| `updated_at` | `timestamptz` | `default now()` |

RLS (per the phase-1 plan): `select` to authenticated; `insert`/`update`/`delete`
to `director`/`controller`.

### `public.project_suppliers` (link master → project)

| Column | Type | Notes |
|---|---|---|
| `project_id` | `uuid` | → `projects(id)` **on delete cascade** |
| `supplier_id` | `uuid` | → `suppliers(id)` **on delete cascade** |
| `contract_amount_aed` | `numeric(14,2)` | optional per-project contract value |
| `reference` | `text` | optional contract / PO reference |
| `notes` | `text` | optional |
| — | | `primary key (project_id, supplier_id)` |

The composite primary key is the upsert conflict target. Deleting a supplier
cascades to its links.

---

## 3. Behaviour

### List

- Loads with `SF.db.selectStrict('suppliers', { company_id }, 'name', true)` so a
  missing table surfaces the migration hint rather than an empty list.
- Header shows the company name and a supplier count, plus a **➕ New supplier**
  button (manager-only by view role).
- Table columns: **Name**, **Kind** tag (`supplier` / `subcontractor` / `both`),
  **Trade**, **TRN**, **Contact** (person · phone · email), **Payment terms**
  (`Net N days`), **Status** (`active` / `inactive` / `blocked`), **Actions**.
- VAT % is shown as a small sub-line under the name when present.

### Create / edit

`SF.ui.openFormModal` with fields for every column — name, kind, trade, TRN,
contact person, phone, email, address, bank name, IBAN, account no., payment
terms (days), VAT %, status. Writes go through `SF.db.insert` / `SF.db.update`
(audit trail + dropped-column tolerance). `company_id` and `created_by` are set
server-side-by-the-module.

### Deactivate / activate / delete

- **Deactivate** flips `status` `active → inactive`; **Activate** flips
  `inactive`/`blocked → active`. Each asks for confirmation.
- **Delete** removes the supplier (and, by cascade, its project links) after
  confirmation.

### Linked projects

- The **🔗** action per supplier opens a modal listing `public.project_suppliers`
  rows for that supplier, joined against `SF.data.state.projects` for project
  names, showing `contract_amount_aed` + `reference` + `notes`.
- **Add project** upserts `{ project_id, supplier_id, contract_amount_aed,
  reference, notes }` with `onConflict: 'project_id,supplier_id'` (idempotent).
- **✕ Remove** deletes the link by `(project_id, supplier_id)`.
- Writes use `SF.db.client().from('project_suppliers')` directly.

---

## 4. Public API — `window.SF_modules.suppliers`

Exposed for datalists and the Node checks. All functions are defensive and never
throw; `list` / `lookup` / `active` read the in-memory cache populated by the
last render.

| Member | Signature | Returns |
|---|---|---|
| `list` | `list()` | array of cached supplier rows (copy) |
| `lookup` | `lookup(name)` | matching supplier row or `null` (case-insensitive) |
| `active` | `active()` | array of cached suppliers where `status === 'active'` |
| `linkToProject` | `linkToProject(supplierId, projectId, { contract_amount_aed, reference, notes })` | `Promise<{ data, error }>` (upsert) |
| `unlink` | `unlink(projectId, supplierId)` | `Promise<{ data, error }>` (delete link) |

The phase-1 plan also asks the Lead to expose `SF.suppliers = { list(), lookup(name) }`
from `app.js`; this module's `window.SF_modules.suppliers` is the source the Lead
can alias.

---

## 5. i18n

EN + AR via a local `L` dictionary with English fallback; the active language is
read from `SF.language` (`ar` / `en`). Labels are escaped everywhere with
`SF.helpers.esc` (local fallback provided).

---

## 6. Testing

`node tools/checks/suppliers.mjs` runs, in order:

1. **Static** — `node --check` on the module; greps for the view registration
   (`registerView`, id `suppliers`, company nav, `director`/`controller` roles)
   and the public API keys; SQL-idempotency greps of the phase-1 migration for
   `suppliers` / `project_suppliers` (skipped with a note if the migration file
   is not on disk yet).
2. **Testkit** — once `tools/lib/mock-supabase.mjs` mirrors the `suppliers` /
   `project_suppliers` tables (the harness owner adds the fixtures), boots the
   real app headless and asserts: the view renders, `lookup`/`active`/`list` work,
   and `linkToProject` upserts idempotently while `unlink` removes the link.
   If the mock lacks `suppliers`, the testkit step prints
   `skipped (mock not ready)` and exits 0.
