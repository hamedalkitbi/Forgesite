# Receiving / GRN module — project-scoped Goods Received Notes

Owner: grn-module. Contract: [`CONTRACT.md`](CONTRACT.md) + [`phase2-plan.md`](phase2-plan.md).

- Module: [`scripts/modules/grn.js`](../../scripts/modules/grn.js) (one self-contained IIFE, no `app.js` edits)
- Migration: [`supabase/migrations/202611050002_phase2_workflow.sql`](../../supabase/migrations/202611050002_phase2_workflow.sql) (owned by db-engineer2; also creates the other phase-2 tables/functions)
- Checks: [`tools/checks/grn.mjs`](../../tools/checks/grn.mjs) — `node tools/checks/grn.mjs`
- View: `grn` (sidebar → **project** section, icon 📦), roles `director` / `controller` / `super`.

A project-level register of goods received against approved purchase orders. Managers
and supervisors list, record, edit and delete Goods Received Notes, each linked to a
material (PO) with an auto reference `GRN-0001…GRN-9999` (next number per project). The
list shows the received quantity against the ordered quantity with a ✓/⚠ match badge
(matched = `sum(qty_received) >= material.qty`).

---

## 1. Install (one time)

Run the migration in the Supabase SQL editor (or `supabase db push`):

```
supabase/migrations/202611050002_phase2_workflow.sql
```

It must be idempotent (`create table if not exists`, `create or replace function`,
`drop policy if exists` before each `create policy`). Until it is run, the GRN view
shows the migration filename plus the exact PostgREST error instead of a blank page.

Rollback instructions are in the migration header.

---

## 2. Data model

### `public.goods_received_notes` (project-level)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `default gen_random_uuid()` |
| `project_id` | `uuid` | → `projects(id)` **on delete cascade** |
| `material_id` | `uuid` | → `materials(id)` **on delete set null** |
| `supplier_id` | `uuid` | → `suppliers(id)` **on delete set null** |
| `reference` | `text` not null | `GRN-0001` (unique per project) |
| `received_date` | `date` not null | |
| `qty_received` | `numeric(14,2)` not null | `check (qty_received >= 0)` |
| `received_by` | `text` | actor name |
| `notes` | `text` | optional |
| `status` | `text` | `default 'received'` |
| `created_at` | `timestamptz` | `default now()` |

RLS (per the phase-2 plan): `select` to authenticated; `insert` to
`director`/`controller`/`super`; `update`/`delete` to `director`/`controller`.

---

## 3. Behaviour

### List

- Loads with `SF.db.selectStrict('goods_received_notes', { project_id }, 'received_date', false)`
  so a missing table surfaces the migration hint rather than an empty list.
- Header shows the project name and a note count, plus a **➕ Record receipt** button.
- Table columns: **Reference**, **PO / Material** (`PO-#### · description`), **Supplier**,
  **Received** (date), **Qty received / ordered** (`received / ordered unit` + ✓/⚠ match
  badge), **Received by**, **Status**, **Actions**.
- The match badge is per material: ✓ (green) when the total received across all GRNs for
  that material is `>=` the ordered quantity, otherwise ⚠ (amber).

### Create / edit

`SF.ui.openFormModal` with a **material select** populated from
`SF.data.state.materials` filtered to `status === 'approved'` (option label
`PO · description`), plus **qty received** (number, required, `min 0`), **received date**
(default today), **received by** (default current user) and **notes**. Writes go through
`SF.db.insert` / `SF.db.update` (audit trail + dropped-column tolerance). `project_id` and
the auto `reference` are set by the module; `supplier_id` is resolved from the material's
supplier name against `SF.data.state.suppliers` (left `null` when no match).

### Auto reference

`GRN-0001`, `GRN-0002`, … per project. The next number is the maximum numeric suffix of
existing `reference` values for the loaded project rows, plus one, zero-padded to four
digits. The view reloads after each write so the counter never repeats within a session.

### Delete

**🗑 Delete** removes the goods received note after confirmation via `SF.db.remove`.

---

## 4. Public API — `window.SF_modules.grn`

Exposed for other modules, the Lead's `app.js` integration, and the Node checks. All
functions are defensive and never throw; `list` / `receivedQty` / `matched` read the
in-memory cache populated by the last render (mirrors `SF_modules.suppliers`).

| Member | Signature | Returns |
|---|---|---|
| `list` | `list()` | array of cached GRN rows (copy) |
| `receivedQty` | `receivedQty(materialId)` | `number` — `sum(qty_received)` for that material |
| `matched` | `matched(materialId)` | `boolean` — `receivedQty >= material.qty` (false when material unknown) |
| `add` | `add(materialId, qtyReceived[, { received_date, received_by, notes, status }])` | `Promise<{ data, error }>` (inserts with auto `GRN-####` reference) |
| `remove` | `remove(id)` | `Promise<{ data, error }>` (deletes a GRN) |

The phase-2 plan also asks the Lead to expose `SF.grn = { receivedQty(materialId),
forMaterial(materialId), add(...) }` from `app.js`; this module's `window.SF_modules.grn`
is the source the Lead can alias.

---

## 5. i18n

EN + AR via a local `L` dictionary with English fallback; the active language is read from
`SF.language` (`ar` / `en`). Labels are escaped everywhere with `SF.helpers.esc` (local
fallback provided).

---

## 6. Testing

`node tools/checks/grn.mjs` runs, in order:

1. **Static** — `node --check` on the module; greps for the view registration
   (`registerView`, id `grn`, project nav, `director`/`controller`/`super` roles) and the
   public API keys; SQL-idempotency greps of the phase-2 migration for
   `goods_received_notes` (skipped with a note if the migration file is not on disk yet).
2. **Testkit** — once `tools/lib/mock-supabase.mjs` mirrors the `goods_received_notes`
   table (the harness owner adds the fixtures), boots the real app headless and asserts:
   the view renders, `receivedQty` sums across multiple GRNs, `matched` flips at the
   ordered quantity, and `add`/`remove` insert (with an auto `GRN-####` reference) and
   delete rows. If the mock lacks `goods_received_notes`, the testkit step prints
   `skipped-pending (mock not ready)` and exits 0.
