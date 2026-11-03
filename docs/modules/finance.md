# Financial Accounts module (`scripts/modules/finance-statements.js`)

Company-level **Financial Accounts** view: Receivables (AR) with ageing, Payables (AP) with
ageing, a **derived Balance Sheet** that balances by construction, and a **P&L /
project profitability** statement.

The view is registered through the module bridge (`docs/modules/CONTRACT.md`), so `app.js`,
`index.html` and `styles/main.css` are untouched. It is **company-scoped**: every table is
fetched without a project filter and aggregated across all projects. Nav section `company`,
roles `director` and `controller`.

| File | Purpose |
|---|---|
| `scripts/modules/finance-statements.js` | Module (UI + deterministic statement maths + CSV/print) |
| `supabase/migrations/202611031002_finance_statements.sql` | Optional `finance_settings` table (RLS) |
| `docs/modules/finance.md` | This document |
| `tools/checks/finance.mjs` | Static + pure-math + headless-browser checks |

---

## 1. Data sources

Loaded with `SF.db.selectStrict(table, null, null, false)` — **no project filter**, so the
statements always cover the whole company regardless of the project selected in the top bar.

| Table | Used for | Absence behaviour |
|---|---|---|
| `progress_billings` | AR, retention/VAT payable, P&L revenue, project revenue | core table; warning banner, empty data |
| `payments` | received cash, paid supplier invoices, pending supplier invoices | core table; warning banner |
| `materials` | approved material cost / material AP / P&L cost | core table; warning banner |
| `timesheets` | approved labour cost (P&L, project profitability) | core table; warning banner |
| `company_expenses` | overhead cost, cash outflow | core table; warning banner |
| `company_budget_lines` | overhead budget vs actual (P&L tab) | core table; warning banner |
| `project_parties` | party names on payment-request rows | core table; warning banner |
| `projects` | project code/name in drill-downs and profitability | core table; warning banner |
| `companies` | company branding (print header) | core table; warning banner |
| `payment_requests` | approved-unpaid payable, paid request cash outflow | **optional** — treated as empty, no error |
| `finance_settings` | opening cash / opening equity / fiscal year | **optional** — AED 0 defaults, no error |
| `payslips` | not queried (P&L labour comes from approved timesheets) | never touched |

A *hard* warning banner is rendered only when a core table query returns an error. Missing
`payment_requests` and `finance_settings` are expected before the migrations are deployed and
degrade silently; `finance_settings` additionally shows a quiet "using AED 0 opening balances"
note in the Opening balances card (not an error state).

---

## 2. Derivation rules

All subtotals are rounded to **2 decimals** (`round2`, half-away-from-zero with a 1e-9
epsilon guard). Formatting always goes through `SF.helpers.money` / `SF.helpers.money0` — raw
floats are never printed.

"Certified certificates" = `progress_billings` rows with status `certified` **or** `paid`
for revenue, retention and VAT purposes. For receivables the two statuses are treated
differently — see §2.1: a **`paid` certificate is settled by status**.

### 2.1 Accounts Receivable (AR) — status-aware settlement

A certificate with `status = 'paid'` is **settled**: the app's IPC list already shows it as
paid, so it is never an outstanding receivable, never appears in the AR ageing and never
inflates the Overdue KPI. A certificate with `status = 'certified'` is an **open** receivable
until a receipt covers it.

Receipts recorded in `payments` (`payment_type = 'received'`, `status ≠ 'cancelled'`) are
applied in this order:

1. **to paid certificates first**, up to their net payable (they represent the same client
   payment that settled the IPC — this is what removes the double count when an IPC is marked
   paid *and* the receipt is also recorded);
2. any remaining receipts **FIFO to open certified certificates**, oldest due date first;
3. anything left after every paid + certified certificate is covered is an **unapplied client
   advance**: AR is negative and it is shown as a current-bucket credit row.

```
certifiedNet = Σ net_payable   for status = 'certified'          (open receivables)
paidNet      = Σ net_payable   for status = 'paid'               (settled by status)
receipts     = Σ amount        for received payments (status ≠ cancelled)
appliedToPaid = min(receipts, paidNet)
pool          = receipts − appliedToPaid
appliedToCertified = min(pool, certifiedNet)      (FIFO over open invoices)
AR            = round2(certifiedNet − pool)         (may be negative = client advance)
```

Equivalently `AR = certifiedNet − max(0, receipts − paidNet)`. The Receivables tab prints a
**settlement reconciliation** line (`paidNet`, receipts applied to paid certificates, receipts
applied to certified invoices, unapplied advances) and the CSV/print pack repeat it.

Consequences, all covered by `tools/checks/finance.mjs`:

| Situation | AR / Overdue behaviour |
|---|---|
| paid certificate, no receipt row | settled by status → excluded from AR and Overdue |
| paid certificate **and** matching receipt | receipt is consumed by the paid certificate → no double count |
| certified certificate + receipt | receipt reduces that open invoice (FIFO) |
| receipts below paidNet | all receipts deemed applied to paid certificates; open certified AR untouched |
| receipts above paid + certified | negative AR (client advance), current-bucket credit row; ageing total == AR |
| only receipt signals (status never flipped) | works as before: certified invoices are reduced by receipts |

The ageing total always equals AR exactly because the advance/credit row is part of the ageing
detail.

### 2.2 Ageing

Every AR/AP line is aged with a **whole-day difference** from due date to the as-of date
(local "today" via `SF.helpers.today()`):

```
daysPastDue = dayIndex(asOf) − dayIndex(dueDate)        (UTC calendar-day index)
```

`dueDate` resolution order: `due_date` → invoice date (`invoice_date`) → `period_to`
(billing period end) → `created_at`. A line with no usable date is treated as **current**
(0 days past due) — the conservative convention: it is never reported as overdue.

| Bucket | Rule (`daysPastDue`) | Boundary proof | UI key |
|---|---|---|---|
| Current (not yet due) | `≤ 0` | due tomorrow = −1; **due today = 0 → current** | `current` |
| 1–30 days | `1 … 30` inclusive | 30 days → 1–30 | `d1_30` |
| 31–60 days | `31 … 60` inclusive | 31 days → 31–60, 60 days → 31–60 | `d31_60` |
| 61–90 days | `61 … 90` inclusive | 61 days → 61–90, 90 days → 61–90 | `d61_90` |
| 90+ days | `> 90` (91 or more) | **91 days → 90+** | `d90plus` |

Examples with as-of `2026-03-05` (non-leap year):

| Due date | daysPastDue | Bucket |
|---|---|---|
| 2026-03-06 | −1 | Current |
| 2026-03-05 | 0 | Current |
| 2026-03-04 | 1 | 1–30 |
| 2026-02-03 | 30 | 1–30 |
| 2026-02-02 | 31 | 31–60 |
| 2026-01-04 | 60 | 31–60 |
| 2026-01-03 | 61 | 61–90 |
| 2025-12-05 | 90 | 61–90 |
| 2025-12-04 | 91 | 90+ |

AR rows are open **certified** certificates only (paid certificates are settled and
excluded); after paid-certificate consumption, receipts are allocated **FIFO to the oldest
due date first** before ageing. Approved material costs are offset FIFO by paid supplier
invoices before ageing material AP. Each tab shows the bucket table (count, amount, share)
plus a drill-down table with days past due.

### 2.3 Accounts Payable (AP)

```
approvedRequests = Σ net_aed             payment_requests with status = 'approved'
paidSupplier     = Σ amount              payments with payment_type ∈ {pending, invoice},
                                          status = 'paid'
materialAp       = max(0, Σ approved materials (quantity × unit_cost_aed) − paidSupplier)
pendingInvoices  = Σ amount              payments with payment_type ∈ {pending, invoice},
                                          status ∉ {paid, cancelled}
AP               = round2(approvedRequests + materialAp + pendingInvoices)
```

Assumptions:

- Paid supplier invoices offset approved material costs first; any excess (paid more than the
  approved material register) is a cash outflow only, never negative AP.
- `payment_requests` net = `net_aed` when present, else `amount_aed − retention_aed`.
- A request is payable only when **approved**; `draft`, `submitted`, `rejected` and `paid` are
  excluded.
- Cancelled `payments` rows are ignored everywhere.

### 2.4 Cash

```
received          = Σ payments received (status ≠ cancelled)
paidSuppliers     = Σ supplier invoices actually paid
expenses          = Σ company_expenses where status ≠ 'rejected'
paidRequests      = Σ net_aed of payment_requests with status = 'paid'
cashMovement      = round2(received − paidSuppliers − expenses − paidRequests)
closingCash       = round2(opening_cash_aed + cashMovement)
```

Opening cash comes from `finance_settings` for the company/fiscal year (default 0). Pending
company expenses are counted as cash outflows (they are recorded obligations); only rejected
expenses are excluded.

### 2.5 Balance sheet (derived, balanced by construction)

```
Assets      = round2(closingCash + AR)
Liabilities = round2(AP + retentionPayable + VATpayable)

retentionPayable = Σ retention_amount  for certified/paid certificates
VATpayable       = Σ vat_amount        for certified/paid certificates

Equity              = round2(Assets − Liabilities)
currentPeriodResult = round2(Equity − opening_equity_aed)     (disclosure)
diff                = round2(round2(Assets − Liabilities) − Equity)   ≡ 0.00
balanced            = |diff| ≤ 0.01
```

Because Equity is *defined* as Assets − Liabilities, `Assets − Liabilities − Equity` is
identically 0 and the sheet cannot be out of balance. The UI still renders the arithmetic
check row and only shows the red **Imbalance** badge if that check fails (it cannot, by
construction — asserted in the checks for awkward cents too). Opening cash is an asset and
opening equity is disclosed inside Equity; setting only one of them shifts the implied
current-period result, so record both consistently in Opening balances.

### 2.6 P&L / project profitability

```
Revenue        = Σ total_claim   for certified/paid certificates   (VAT excluded)
materialsCost  = Σ approved materials (quantity × unit_cost_aed)
labourCost     = Σ total_cost_aed of approved timesheets
overhead       = Σ company_expenses (status ≠ 'rejected')
directCost     = round2(materialsCost + labourCost)
totalCost      = round2(directCost + overhead)
grossProfit    = round2(Revenue − directCost)     grossMargin = grossProfit / Revenue × 100
netProfit      = round2(Revenue − totalCost)      netMargin   = netProfit / Revenue × 100
```

**VAT is excluded from revenue**: `total_claim` is the gross cumulative valuation; VAT lives
in the separate `vat_amount` column and is reported as VAT payable, not revenue. The P&L tab
also shows `Σ current_net_excl_vat` ("This-period revenue") for reconciliation because
`total_claim` on each certificate is cumulative.

Project profitability groups revenue/materials/labour/expenses by `project_id`; company
expenses without a `project_id` stay company overhead. The tab also shows the company overhead
budget vs actual from `company_budget_lines`.

---

## 3. UI

- **Header**: title, company name, as-of date, Refresh, Export CSV, Print/PDF.
- **Tabs** (`role="tablist"`, `.settings-tabs`/`.stab`): Receivables, Payables, Balance Sheet,
  Profit & Loss. Tab switching re-paints from cached data (no refetch).
- **KPI cards** (`.kpi` + colour variants) and drill-down tables (`.card`, `.tright`, `.mono`,
  `.tag`, `.empty`) matching the app's visual language.
- **Balance Sheet tab**: statement rows, verification row `Assets − Liabilities − Equity` with
  the balanced badge, Opening balances card (opening cash / opening equity / fiscal year /
  notes) with a manager-only **Edit opening balances** button using `SF.ui.openFormModal`, and
  a **Print full pack** button.
- **Receivables tab**: shows the open-certificate drill-down plus a **settlement reconciliation**
  line (paid certificates settled by status, receipts applied to paid certificates, receipts
  applied to certified invoices, unapplied advances) so a user can see why AR differs from the
  gross certificate list.
- **Loading state**: the view paints a loading card, then swaps in the statements; a generation
  token + `[data-sf-finance]` marker stop a slow response from painting over another view.
- **Never throws**: synchronous render and the async loader are both wrapped; a failure renders
  an error card instead of breaking the app shell.
- **Permissions**: the view is only registered for `director`/`controller`. Opening-balance
  edits are additionally guarded by `SF.ui.canManage()` in the click handler (so a stale DOM
  cannot bypass it).
- **i18n**: full EN/AR label dictionary (`L` object + `pick()`), including tab labels, table
  headers, KPI labels, derivation notes and the printed pack; Arabic uses the app's `dir="rtl"`.

---

## 4. CSV export

`Export CSV` downloads the active tab as `finance_<tab>_<asof>.csv`:

- every cell passes through `csvCell()`: values beginning with `= + - @` (or tab/CR) are
  prefixed with `'` to block spreadsheet formula injection; numbers stay numeric;
- cells containing `"`, `,`, CR or LF are RFC-4180 quoted and inner quotes doubled;
- the file is written with a **UTF-8 BOM**, `text/csv;charset=utf-8`, via
  `Blob → URL.createObjectURL → <a download>.click()`.

## 5. Print / PDF

Print opens a company-branded document in a new window and calls `print()`:
logo (through `safeImgSrc`), company name/address/TRN/contact, statement title, as-of date,
ageing + drill-down tables, totals, balance-sheet verification line, signatures and the
derivation note. The document declares `dir="rtl" lang="ar"` when the app language is Arabic
and `dir="ltr" lang="en"` otherwise. Every interpolated value is HTML-escaped. The Balance
Sheet tab's **Print full pack** prints all four statements.

---

## 6. Migration & settings

`supabase/migrations/202611031002_finance_statements.sql` creates:

```sql
create table if not exists public.finance_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  fiscal_year integer,
  opening_cash_aed numeric(14,2) not null default 0,
  opening_equity_aed numeric(14,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  constraint finance_settings_company_year_key unique (company_id, fiscal_year)
);
```

- Idempotent (`create table/index if not exists`, `create or replace function`,
  `drop policy if exists` before each `create policy`), non-destructive, header comment with
  purpose/run instructions/rollback notes.
- RLS enabled: `select` for any authenticated user; `insert`/`update`/`delete` only when
  `public.sf_current_role() in ('director','controller')` (helper created or replaced per the
  contract).
- **Optional for rendering**: without the table the module uses AED 0 opening cash/equity and
  the balance sheet still balances. Run it to persist opening balances from the UI.
- Row selection picks the current company's row for the current calendar fiscal year, falling
  back to the company's first row.

---

## 7. Public API (for tests and other modules)

```js
window.SF_modules.finance = {
  ageing(rows, {today})        // rows: [{due_date|invoice_date|period_to|date, amount|net_payable, ...}]
                               // → {current, d1_30, d31_60, d61_90, d90plus, total, buckets[], rows[], asOf}
  arTotal(data, opts)          // data: {billings, payments}
                               // → {ar, certifiedNet, paidNet, paidCount, received,
                               //    receiptsAppliedToPaid, receiptsAppliedToCertified, advance, count}
  apTotal(data, opts)          // data: {paymentRequests, materials, payments}
                               // → {ap, paymentRequests, materials, payments, paidSupplier, ...}
  balanceSheet(data, opts)     // data: all tables + optional settings
                               // → {assets, liabilities, equity, cash, ar, ap, retentionPayable,
                               //    vatPayable, openingCash, openingEquity, currentResult, diff, balanced}
  pnl(data, opts)              // data: {billings, materials, timesheets, expenses}
                               // → {revenue, materials, labour, expenses, directCost, grossProfit,
                               //    netMargin..., projects[]}

  // extras used by the UI / checks
  arAgeing(data, opts), apAgeing(data, opts), compute(data, opts), normalize(data),
  csvCell(v), buildCSV(rows), printHTML(tab, data, opts), money(n), money0(n),
  round2(n), bucketFor(daysPastDue), dayIndex(date)
};
```

All five required functions are **pure and deterministic**: they accept plain DB-shaped rows
(snake_case accepted, tolerant of nulls/strings) and an optional `{today: 'YYYY-MM-DD',
settings: {...}}`. They never touch the DOM or app state, so checks can call them with fixture
rows through CDP `Runtime.evaluate` or a `node:vm` sandbox. `tab` for `printHTML` is
`'ar' | 'ap' | 'bs' | 'pnl' | 'all'`.

---

## 8. Tests

`node tools/checks/finance.mjs` (dependency-free, exits non-zero on failure — 47 checks):

1. **Static** — files exist, module parses, IIFE guards missing `SF`, view registered for
   `company`/`director`+`controller`, required API keys, project-filter-free `selectStrict`
   fetches, money helpers, CSV formula-prefix + BOM, dir-aware print builder, 0.01 identity
   tolerance, `canManage` guard.
2. **Migration** — idempotent DDL, RLS policies + `sf_current_role()`, non-destructive outside
   its rollback comment.
3. **Pure maths in `node:vm`** — AR/AP hand-computed totals, the status-aware settlement
   regression (paid certificate with no receipt is excluded from AR and Overdue; paid
   certificate + matching receipt does not double count; receipts below paid net are consumed
   by paid certificates; over-receipts become a negative AR advance; closed form
   `AR = certifiedNet − max(0, receipts − paidNet)`), ageing boundaries (30/31, 60/61, 90/91,
   due-today, invoice-date fallback, undated), FIFO allocation totals, balance-sheet identity
   incl. paid certificates, awkward cents and missing settings, P&L excl. VAT, project
   profitability, missing optional tables, null-safe mapping, CSV injection, AR/EN print
   escaping.
4. **Browser** (`tools/lib/testkit.mjs`) — `withApp({role:'director'})`, `goView('finance')`,
   renders with the mock fixtures, live API reproduces fixture totals, the mock company's
   `paid` certificate (`PB-002`) is absent from the receivable rows and Overdue KPI while the
   reconciliation line is visible, balanced badge and identity row in the DOM, tab switching,
   live CSV escaping, manager-only opening-balances modal, Arabic UI (`settings.language='ar'`),
   zero JS exceptions. A lead-role run asserts the view is denied for non-finance roles.

Fixture totals used by both layers (as-of `2026-03-05`): AR `9,500`, AP `7,500`, assets
`29,100`, liabilities `9,675`, equity `19,425`, identity diff `0.00`, revenue `15,000` excl.
VAT (VAT `675` reported separately). The fixture has no paid certificates; the headless-browser
layer additionally asserts the status-aware rule on the mock company data (`PB-002` is
`paid`): it must not appear in the receivable rows, the AR must equal open certified net
because receipts are consumed by the paid certificate, and the Overdue KPI must only count
open certified certificates.

---

## 9. Assumptions & limitations

- **`status = 'paid'` is authoritative settlement for receivables.** It is removed from AR and
  the Overdue KPI; recorded receipts are consumed by paid certificates first (up to their net
  payable) so recording both the status flip and the client receipt cannot double count.
  A paid certificate is treated as fully settled even if the recorded receipt is smaller than
  its net payable — the reconciliation line discloses both numbers.
- Certificates are cumulative (`total_claim` / `net_payable` are cumulative values). The
  statements sum certified/paid rows for revenue, and open certified rows for AR; per-period
  analysis is shown as "This-period revenue" (`current_net_excl_vat`) for reconciliation.
- Retention is treated as payable until released — the schema has no release flag, so all
  certified/paid certificates contribute.
- Paid supplier invoices are identified by `payment_type ∈ {pending, invoice}` and
  `status = 'paid'`; they are netted against approved material costs. There is no direct
  material↔payment foreign key.
- `company_expenses` rows count unless `status = 'rejected'`.
- `SF.db.selectStrict` uses PostgREST's default page limit (1,000 rows per table). For larger
  companies a paginated company-wide variant would be needed; the module intentionally uses the
  contract helper so missing tables are detectable.
- Opening balances assume AED and the current calendar fiscal year; multi-currency ledgers are
  out of scope.
