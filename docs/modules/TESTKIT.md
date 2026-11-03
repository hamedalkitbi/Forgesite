# TESTKIT — headless browser harness for SiteForge

`tools/lib/testkit.mjs` + `tools/lib/mock-supabase.mjs` boot the **real** app (real `scripts/app.js`,
real `scripts/modules/*.js`, real CSS) in headless Chrome against a completely mocked Supabase, so
feature checks can sign in, open a project, click through views and assert on real DOM/state —
with **zero npm dependencies**.

Used by `tools/tests/app-views.mjs` (the full view smoke test) and by every
`tools/checks/<feature>.mjs` module check.

Requirements: Node >= 20 and a local Chrome/Chromium (`CHROME_PATH` overrides discovery).

```bash
# Every built-in view + module view renders, restricted views denied (31 checks)
node tools/tests/app-views.mjs

# The app's own zero-dependency suite (static assets, helpers, PWA, a11y, offline)
node tools/run-tests.mjs
```

Both print `✓`/`✗` lines and exit non-zero on failure.

---

## 1. Quick start for a feature check

Create `tools/checks/<feature>.mjs`:

```js
import assert from 'node:assert/strict';
import { withApp, runFeatureChecks } from '../lib/testkit.mjs';

const checks = [
  {
    name: 'payslips view renders and saves idempotently',
    async fn() {
      await withApp({ role: 'director', project: 0 }, async ({ evaluate, goView, diagnostics, getMockDb }) => {
        await goView('payslips');
        assert.ok((await evaluate('document.getElementById("main").textContent')).length > 0);

        const result = await evaluate(`(async function () {
          var client = window.SF.db.client();
          await client.from('payslips').upsert(
            [{ project_id: window.SF.currentProjectId, worker_id: 'w1', period: '2026-10', net_aed: 100 }],
            { onConflict: 'project_id,worker_id,period' }
          );
          await client.from('payslips').upsert(
            [{ project_id: window.SF.currentProjectId, worker_id: 'w1', period: '2026-10', net_aed: 120 }],
            { onConflict: 'project_id,worker_id,period' }
          );
          var rows = await client.from('payslips').select('*').eq('period', '2026-10');
          return { count: rows.data.length, net: rows.data[0].net_aed };
        })()`);

        assert.equal(result.count, 1, 'upsert must not duplicate rows');
        assert.equal(result.net, 120, 'upsert must merge values');
        assert.deepEqual(diagnostics.errors, [], 'no JS exceptions');
      });
    }
  }
];

const { failed } = await runFeatureChecks({ name: 'Payslips checks', tests: checks });
process.exitCode = failed ? 1 : 0;
```

Run it with `node tools/checks/payslips.mjs`.

---

## 2. `withApp(options, fn)` API

Boots a fresh static server + fresh headless Chrome, injects the mock before any page script,
navigates to `/index.html?selftest=1&nosw=1`, drives the login form through `window.doLogin()`,
waits for `#appShell`, optionally opens a project, then calls `fn(helpers)`. Everything
(client, Chrome, server) is always closed afterwards, even when `fn` throws.

### Options

| Option | Default | Meaning |
|---|---|---|
| `role` | `'director'` | Profile to sign in as: `director`, `controller`, `super`, `lead` (fixtures), or a username added through `fixtureOverrides.profiles`. Any non-empty password is accepted. |
| `username` | `role` | Override the login username when it differs from the expected role. |
| `project` | `null` | Project to open after login: project **uuid**, project **code** (`'PRJ-001'`), project **name**, or **0-based index** (`0`). `null` keeps the company context. |
| `settings` | `{}` | localStorage `siteforge_settings_v1`, merged over `{language:'en', theme:'dark'}`. Use `{ language:'ar' }` to test RTL. |
| `fixtureOverrides` | `null` | `{ tableName: rows[] }` — **replaces** seeded tables *before* the app boots, so `loadCompanyData()`/`loadProjectData()` see them. |
| `settleMs` | `260` | Extra wait after each helper navigation, to let async renders settle. |
| `timeoutMs` | `30000` | Timeout for each internal wait. |

### Helpers passed to `fn`

| Helper | Description |
|---|---|
| `client` | CDP client from `tools/lib/cdp.mjs` (`send`, `evaluate`, `on`, `close`). |
| `server` | `{ url, close }` from `tools/lib/server.mjs`. |
| `chrome` | `{ port, close }` from `tools/lib/cdp.mjs`. |
| `evaluate(expression)` | Evaluate in the page with `awaitPromise: true`, returns the value. Throws on page exceptions. |
| `goView(viewId)` | Calls `window.goView(id)`, waits for `#main` to have content, waits `settleMs`, returns the detected active view id (or `null`). |
| `waitFor(predicate, {timeout, interval, label})` | Polls a page **expression string** (or a Node async function) until truthy; throws a labelled timeout. |
| `seedTable(table, rows)` | Replaces a table in the live mock DB (`window.__MOCK.seedTable`). Views that load on demand pick it up; cached `SF.data.state` is only refreshed by a reload/project switch. |
| `getMockDb()` | Returns `window.__MOCK_DB` (all tables, plain JSON). |
| `getState()` | Returns `window.SF.data.state` (the live app state). |
| `currentView()` | Detected active view id from the highlighted sidebar item, or `null`. |
| `diagnostics` | `{ errors, warnings, logs, clear() }` collected from the page (uncaught exceptions, `console.error`, browser log errors). Call `diagnostics.clear()` before a step to isolate it. |
| `projectId` | The id of the project opened through `project` (or `null`). |
| `role`, `username` | Effective login role/username. |

### Detection caveat

`currentView`/`goView()` find the view via the highlighted sidebar item. While a project is open the
sidebar only renders the project + system sections, so **company-section views** (`company-dash`,
`projects-list`, `expenses`, `company-budget`, `workers`, `compliance`, `finance`) report `null`.
Check those in a company context (`project: null`) or assert on `#main` content instead. This is how
`tools/tests/app-views.mjs` splits its company and project passes.

---

## 3. `runFeatureChecks({ name, tests })`

```js
const summary = await runFeatureChecks({ name: 'Payslips checks', tests: [{ name, fn }, ...] });
// prints ✓/✗ lines + "${passed}/${total} passed", returns { passed, failed, results }
```

- Each `test.fn` may be async; a throw marks it failed and the run continues.
- It does **not** set `process.exitCode` — do that in your check file
  (`process.exitCode = summary.failed ? 1 : 0;`).
- `withApp(...)` inside a test is fine; cleanup is guaranteed even on assertion failure.

---

## 4. Mock Supabase (`tools/lib/mock-supabase.mjs`)

`MOCK_SOURCE` is a self-contained classic script injected with
`Page.addScriptToEvaluateOnNewDocument` **before any page script**. It installs a
`window.supabase` accessor that survives the real supabase-js CDN bundle loading later (the real
library is stashed on `window.__REAL_SUPABASE`), so the app always talks to the mock.

### Auth

`createClient(url, key, options)` → client with:

- `auth.signInWithPassword({ email, password })` — looks up a seeded profile by email **or** username;
  returns `{ data: { user, session }, error }`. Disabled profiles (`active:false`) error.
- `auth.getSession()` / `auth.setSession({access_token, refresh_token})` / `auth.refreshSession()`
- `auth.onAuthStateChange(cb)` → `{ data: { subscription: { unsubscribe() } } }`; emits `SIGNED_IN` /
  `SIGNED_OUT`.
- `auth.signOut()`, `auth.updateUser({password})`, `auth.getUser()`, `auth.admin.*` (stubs).

### PostgREST builder — `client.from(table)`

Chainable **and thenable**; `await` it (or `.then()`) to execute. Supported:

`select(cols)`, `insert(rowOrRows)`, `update(patch)`, `upsert(rowOrRows, { onConflict: 'a,b' })`,
`delete()`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`, `not`, `match`,
`filter`, `order(col, {ascending})`, `range(from, to)`, `limit(n)`, `single()`, `maybeSingle()`.

Resolved value: `{ data, error, count, status }`.

- Mutations support `.select()` chained after them (`insert(...).select()` returns the inserted rows,
  `update(...).eq(...).select('id')` / `delete().eq(...).select('id')` return the affected rows — the
  app relies on the array length for its "0 rows affected" checks).
- `single()` returns `{ data: null, error: { code: 'PGRST116', ... } }` unless exactly one row matches
  (the app uses this for its login profile fallback and "before" snapshots).
- `maybeSingle()` returns `{ data: row|null, error: null }`.
- `upsert` matches rows by every `onConflict` column; a `null`/missing conflict value inserts instead
  of matching (SQL null-distinct semantics); existing rows are merged and keep their `id`.
- Mutations without `.select()` still return the affected rows (a friendly superset of PostgREST).
- Unknown tables are auto-created as empty arrays and **never error**, so a module that queries a
  not-yet-migrated table renders its empty state instead of crashing.

### Storage — `client.storage.from('siteforge-files')`

`upload(path, file, {upsert, contentType})`, `createSignedUrl(path, expiresIn)` →
`{ data: { signedUrl }, error: null }`, `getPublicUrl(path)`, `remove([paths])`, `list(prefix)`,
`download(path)`. Objects live in memory for the page session.

### Edge functions / REST

`window.fetch` is intercepted for:

- `/functions/v1/scan-invoice-real` → plausible invoice JSON (`supplier`, `total`, `vat`, `items`, …)
- `/functions/v1/scan-passport` → plausible passport JSON (`name`, `passport_no`, `visa_expiry`, …)
- `/functions/v1/admin-user-ops` → `{ ok: true, id, email }`
- any other `/functions/v1/*` → `{ ok: true, mock: true }`
- `/rest/v1/<table>?...` → rows from `window.__MOCK_DB` (used only by the app's profile fallback)

All other fetches pass through to the real `fetch`.

### Shareable store and runtime helpers

Everything is visible and mutable from `page.evaluate` / Node:

| Global | Description |
|---|---|
| `window.__MOCK_DB` | Plain object: every table as an array of rows (`companies`, `profiles`, `projects`, `boq_items`, `materials`, `payments`, `progress_billings`, `project_parties`, `site_reports`, …). |
| `window.__MOCK_SEED` | Pristine copy of the seed data. |
| `window.__MOCK.seedTable(table, rows)` | Replace one table. |
| `window.__MOCK.reset()` | Restore the seed DB and clear the auth session. |
| `window.__MOCK.tables()` | Table names currently in the store. |
| `window.__MOCK.session()` | Current auth session. |
| `window.__MOCK.uuid()` | New deterministic-ish uuid for inserts. |
| `window.__applyMockOverrides(map)` | Used by `withApp({fixtureOverrides})` before boot. |

Ids are deterministic uuid-shaped strings (e.g. `d0000000-0000-4000-8000-000000000001`) so
assertions can reference fixtures directly. Dates are relative to the run date, so compliance/permit
alerts are always "fresh" (expired, expiring and valid examples exist).

### Seeded fixtures

- **Company**: Al Nakheel Contracting LLC.
- **Profiles / login usernames**: `director` (Hamed Al Kitbi), `controller` (Fatima Al Mansoori),
  `super` (Ravi Kumar), `lead` (Ahmed Hassan). Emails are `<username>@example.com`.
- **Projects**: `PRJ-001` Al Barsha G+M Warehouse (AED 12.5M, overrun + approved/pending COs) and
  `PRJ-002` JVC G+1 Villa.
- **Tables seeded**: `companies`, `profiles`, `projects`, `budget_lines`, `boq_items`,
  `company_budget_lines`, `company_expenses`, `workers` (notes JSON with
  `salary`/`loan`/`deduct`, expiring + expired permits), `timesheets` (approved + pending),
  `materials` (approved + pending + one unlinked), `payments` (received/pending/invoice/overdue),
  `progress_billings` (certified+paid with retention/VAT/previous-billed/advance recovery),
  `project_parties` (customer/consultant/subcontractor/supplier), `site_reports` (photo data URIs),
  `payroll_batches`, `compliance_documents` (expired/soon/valid), `transaction_history`, `audit_log`,
  `notifications`, `payment_requests`, `payslips`, `finance_settings`, `drawings`, `attachments`,
  `schedule_items`, `change_orders`, `password_reset_requests`.

Fixture values are realistic and deliberately exercise the app's alert/overrun/pending-approval
paths, so view checks assert on non-empty states rather than empty placeholders.

---

## 5. Role matrix used by the fixtures

| View | director | controller | super | lead |
|---|---|---|---|---|
| company-dash, projects-list, expenses, company-budget, workers, compliance, approvals | ✓ | ✓ | partial | — |
| project-dash, boq, drawings, timeline, materials, payments, parties, change-orders, site-reports | ✓ | ✓ | ✓ | partial |
| timesheets | ✓ | ✓ | ✓ | ✓ |
| payroll, users | ✓ | ✓ (payroll) | — | — |
| settings, history, reports, progress-billing | ✓ | ✓* | ✓* | — |
| `finance` (module) | ✓ | ✓ | — | — |
| `payment-requests` (module) | ✓ | ✓ | ✓ | — |
| `payslips` (module) | ✓ | ✓ | — | — |

`goView()` on a denied view shows the "Access denied" toast and leaves the current view unchanged —
`tools/tests/app-views.mjs` asserts this for lead on `payroll`, `users`, `approvals`.

---

## 6. What `tools/tests/app-views.mjs` covers

31 checks (exit 1 on any failure):

1. **Director, company context** — 11 views: `company-dash`, `projects-list`, `expenses`,
   `company-budget`, `workers`, `compliance`, `settings`, `history`, `approvals`, `users`, `finance`.
2. **Director, `PRJ-001` selected** — 16 views: `project-dash`, `boq`, `drawings`, `timeline`,
   `materials`, `payments`, `parties`, `change-orders`, `timesheets`, `payroll`, `audit`, `reports`,
   `progress-billing`, `site-reports`, `payment-requests`, `payslips`.
3. **Lead** — lands on an allowed view, and `payroll` / `users` / `approvals` are denied
   (`currentView !== requested`).

Every view step asserts: the requested view is active, `#main` has content, and `diagnostics.errors`
is empty for that step (diagnostics are cleared between views).

Monitor these with:

```bash
node tools/tests/app-views.mjs          # view smoke test
node tools/run-tests.mjs                # app regression suite
node tools/checks/<feature>.mjs         # per-feature checks
```

---

## 7. Troubleshooting

- **`scripts/app.js is empty (0 bytes)`** — the working tree lost `app.js`; restore it and re-run.
  `withApp` also fails fast if the `window.SF` module bridge is missing.
- **`No Chrome/Chromium binary found`** — set `CHROME_PATH=/path/to/chrome`.
- **A view redirects unexpectedly** — check the role permissions (section 5) and whether the view is
  project-scoped (`nav.section: 'project'` requires a project). `goView` on a denied/project-less
  view does not change the active view, so assert with `currentView()`/`#main`.
- **Flaky async assertions** — views load data after render; raise `settleMs` in `withApp` or use
  `waitFor` on the DOM/state condition instead of a fixed sleep.
- **Fixture missing** — use `fixtureOverrides` (before boot) or `seedTable` (runtime) instead of
  editing the shared fixtures; the seeded store is shared with other checks if you mutate it.

## 8. Ownership

`tools/lib/*` and `tools/tests/*` are owned by the harness owner. Feature checks live in
`tools/checks/<feature>.mjs` and are owned by the feature owner (see
`docs/modules/CONTRACT.md`). Do not edit `tools/run-tests.mjs` or `scripts/app.js` from a feature
branch; message the Lead instead.
