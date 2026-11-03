# Module contract — extending SiteForge without touching `app.js`

`scripts/app.js` is one IIFE. To add features concurrently, each feature lives in its own
classic script under `scripts/modules/` and registers a view through the `window.SF` bridge.

Loaded order (see `index.html`): `scripts/app.js` → `scripts/modules/*.js`. Scripts are
plain `<script>` tags (no build step, no modules, no bundler).

---

## 1. Registering a view

```js
(function () {
  'use strict';
  if (!window.SF) return;               // app.js failed to boot
  var S = window.SF, H = S.helpers, DB = S.db, UI = S.ui;

  function render(el) {
    // el is <main id="main">, already cleared. Build HTML here.
    el.innerHTML = '…';
  }

  S.registerView({
    id: 'payment-requests',             // required, unique; also the view/route id
    nav: {                              // optional sidebar entry
      section: 'project',               // 'project' (needs a selected project) | 'company'
      icon: '🧾',
      label: 'Payment Requests',
      labelAr: 'طلبات الدفع'
    },
    roles: ['director', 'controller', 'super'], // who may open it (userProfile.role)
    render: render                      // required
  });
})();
```

- `render(el)` is called by `app.js` `render()` for that view. Use `S.ui.render()` to re-render
  the current view after state changes.
- `section: 'project'` views are automatically redirected to the company dashboard when no
  project is selected; `app.js` also adds the nav entry to the right sidebar section.
- `hasView(...)` is extended for module views using `roles`; users outside `roles` never see
  the nav entry and `hasView` denies `goView`.

## 2. Available bridge (`window.SF`)

| Member | Purpose |
|---|---|
| `SF.helpers` | `esc, t, money, money0, num, numOr, fmtDate, fmtTime, today, toLocalDate, daysUntil, safeImgSrc, parsePhotos, genUUID` |
| `SF.db.select(table, filters, orderCol, ascending)` | paginated fetch (1k rows/page), **swallows errors** — legacy behaviour |
| `SF.db.selectStrict(table, filters, orderCol, ascending)` | → `{ rows, error }`; use this so a missing table can show the migration hint |
| `SF.db.insert(table, data)` / `.update(table, id, data[, expectedUpdatedAt])` / `.remove(table, id)` | mutations with audit trail + dropped-column tolerance |
| `SF.db.log(action, table, id, label, projectId, before, after)` | extra audit entry |
| `SF.db.client()` | raw supabase client (storage, auth, RPC) |
| `SF.ui.toast(msg[, cls])` | `cls` is `ok` \| `bad` or empty |
| `SF.ui.openModal(title, body, footer, opts)` / `closeModal()` / `openFormModal(cfg)` | dialogs (focus-trapped) |
| `SF.ui.render()` / `goView(id)` / `canManage()` / `hasView(id)` | app navigation |
| `SF.data.state` | the live app state object |
| `SF.user` / `SF.company` / `SF.currentProject` / `SF.currentProjectId` / `SF.parties` / `SF.language` | getters (may be null) |
| `SF.registerView(def)` | register (idempotent by id) |

## 3. Missing-table handling (required)

New tables are created by migrations the owner runs **after** this branch ships. Until then the
module must degrade gracefully:

```js
var r = await DB.selectStrict('payment_requests', { project_id: pid }, 'created_at', false);
if (r.error) {
  el.innerHTML = card('Payment Requests',
    '<p class="badc">This module needs a database update.</p>' +
    '<p class="mutc">Run <code>supabase/migrations/202611031001_payment_requests.sql</code> in the Supabase SQL editor, then reload.</p>' +
    '<p class="mutc" style="font-size:11px">' + H.esc(r.error.message || r.error) + '</p>');
  return;
}
```

Use `SF.ui.openModal` + `SF.ui.openFormModal` for forms so focus management, validation
(`aria-required`, first-invalid focus) and audit logging come for free. **Never** build a raw
`innerHTML` form without labels.

## 4. Migrations

- Directory: `supabase/migrations/`
- Naming: `YYYYMMDDHHMM_<slug>.sql` (Supabase CLI style). One feature = one file.
- Every file must be **idempotent** (`create table if not exists`, `create index if not exists`,
  `create or replace function`).
- Every new table: `uuid` PK default `gen_random_uuid()`, `project_id uuid references public.projects(id) on delete cascade` (project scoped), `created_at timestamptz default now()`.
- **Enable RLS on every table** and write explicit policies. Managers are `director`/`controller`.
  Helper for role checks (create or replace in each migration is fine):

```sql
create or replace function public.sf_current_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;
```

- Do **not** modify or drop existing tables/columns; do not touch `profiles` policies.
- Add a header comment with: purpose, who should run it, and rollback notes.

## 5. i18n

The app ships EN + AR (`appSettings.language`). Module UI must localise labels at least for
nav and page titles: keep an `L` object `{en:{...}, ar:{...}}` and `pick(x)` helper; fall back
to English. Keep AR strings real (no machine-ish transliteration).

## 6. Tests (each module ships one)

`tools/checks/<feature>.mjs` — dependency-free Node script. Prefer the shared harness:

```js
import { runFeatureChecks } from '../lib/testkit.mjs';
```

If the harness is not on disk yet, fall back to static checks (file parses, migration is
idempotent, view registers, no `innerHTML` without `esc`) and exit non-zero only on real
problems. The Lead runs every `tools/checks/*.mjs` plus `tools/run-tests.mjs` at integration.

## 7. Ownership / conflicts

| File | Owner |
|---|---|
| `scripts/app.js`, `index.html`, `styles/main.css` | Lead only |
| `scripts/modules/<feature>.js`, `supabase/migrations/<feature>.sql`, `docs/modules/<feature>.md`, `tools/checks/<feature>.mjs` | Feature owner |
| `tools/lib/*`, `tools/tests/*` | Harness owner |

Do not edit another owner's files. If you need a bridge addition or a CSS class, message the Lead.
