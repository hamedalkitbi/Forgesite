# Phase 3 — retention release, subcontractor certificates, management exceptions

Contract for the team. Owners per file; do not edit another owner's files.

## DB (owner: db3 — `supabase/migrations/202611050003_phase3.sql`)
Idempotent; end `notify pgrst, 'reload schema';`.

```sql
public.retention_releases (
  id uuid pk default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  amount_aed numeric(14,2) not null check (amount_aed > 0),
  release_date date not null default current_date,
  released_by text, reason text,
  created_at timestamptz default now()
);

public.subcontractor_certificates (
  id uuid pk default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  boq_item_id text,               -- boq_items.id may be text in this deployment
  reference text not null,        -- SC-0001 per project (app-enforced uniqueness)
  period text,                    -- 'YYYY-MM'
  measured_qty numeric(14,2) not null check (measured_qty >= 0),
  rate_aed numeric(14,2) not null,
  certified_amount_aed numeric(14,2) not null,
  status text not null default 'draft' check (status in ('draft','certified','paid')),
  certified_by text, certified_at timestamptz,
  payment_request_id text,        -- linked payment_requests id
  notes text, created_at timestamptz default now()
);
```
RPC: `public.sf_retention_open(p_project uuid) returns jsonb` → `{total_retained, released, open}`
(sum progress_billings.retention_amount for certified/paid, minus retention_releases for the project).

RLS: both tables — select authenticated; write director/controller.

## Modules (owner: modules3 — scripts/modules/{retention,subcertificates,management}.js + docs + tools/checks/{...}.mjs)
- `retention.js` — project nav, roles director/controller. Per project: total retained, released, open; director records a release (amount ≤ open, reason required); history. Expose `SF_modules.retention = {open, released, release, list}`. Migration hint if table missing.
- `subcertificates.js` — project nav, roles director/controller. Measure a BOQ line + supplier → certified amount; list; certify; "Generate payment request" inserts a `payment_requests` row (request_type 'subcontractor', net_aed = certified, status 'submitted') so it flows into approvals. Expose `SF_modules.subcertificates`.
- `management.js` — company nav, roles director/controller. Exception dashboard: overdue approvals (count + value, from approval queue), unlinked material cost, duplicate supplier invoice_no in payments, committed-but-undelivered POs (stage Ordered/In Transit), open retention total. Expose `SF_modules.management`.

All use existing SF bridge only; EN/AR; never throw out of render; migration-hint empty state.

## App/finance (owner: Lead)
- `SF.retention = { releasedTotal(), released(projectId), open(projectId) }` (queries retention_releases).
- finance module: `retentionPayable` subtracts `SF.retention.releasedTotal()` (guarded if absent).
- index.html loads the three modules.

## Tests (owner: verifier3 — tools/lib/mock-supabase.mjs additions + tools/checks/phase3.mjs)
Mirror retention_releases + subcontractor_certificates + sf_retention_open; phase3.mjs asserts: retention open/release math (release ≤ open enforced), certificate measurement math (qty*rate) + generate-payment-request linking + status, management metrics correctness on fixtures, static migration idempotency/RLS.
