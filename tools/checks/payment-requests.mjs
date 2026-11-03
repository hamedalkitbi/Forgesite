#!/usr/bin/env node
// Checks for the Payment Requests module (task-5).
//
// Zero dependencies. Run with:  node tools/checks/payment-requests.mjs
//
// Three layers:
//   1. Static checks  — module parses, view registers, migration is idempotent
//                       and contains the required columns/policies, docs exist.
//   2. Pure math      — retention/net rounding, negative-net validation,
//                       reference sequencing, ageing boundaries, print escaping.
//                       The module exposes these helpers before its window.SF
//                       guard, so a bare `window` sandbox is enough.
//   3. Integration    — when tools/lib/testkit.mjs (built by harness-builder) is
//                       on disk: drive the real view headless as director and
//                       super and assert the rendered HTML + workflow.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const MODULE_PATH = join(ROOT, 'scripts/modules/payment-requests.js');
const MIGRATION_PATH = join(ROOT, 'supabase/migrations/202611031001_payment_requests.sql');
const DOC_PATH = join(ROOT, 'docs/modules/payment-requests.md');
const TESTKIT_PATH = join(ROOT, 'tools/lib/testkit.mjs');

const MIGRATION_FILE = '202611031001_payment_requests.sql';
const TODAY = '2026-11-03'; // fixed "today" so ageing assertions are deterministic

const results = [];
let currentSection = '';

function section(title) {
  currentSection = title;
  console.log(`\n${title}`);
}
function record(name, ok, detail) {
  results.push({ section: currentSection, name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? '\n      ' + detail : ''}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
    return true;
  } catch (error) {
    record(name, false, String(error && error.message ? error.message : error));
    return false;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function matches(value, regexp, label) {
  if (!regexp.test(String(value))) throw new Error(`${label || 'value'} does not match ${regexp}`);
}

/* -------------------------------------------------------------------------- */
/* Load the module inside a vm sandbox                                         */
/* -------------------------------------------------------------------------- */
function loadSandbox(windowObject) {
  const code = readFileSync(MODULE_PATH, 'utf8');
  const sandbox = { window: windowObject, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'scripts/modules/payment-requests.js' });
  return sandbox;
}
function loadPureApi() {
  const sandbox = loadSandbox({});
  const api = sandbox.window.SF_modules && sandbox.window.SF_modules['payment-requests'];
  assert(api, 'window.SF_modules["payment-requests"] was not exported without SF');
  return api;
}

/* -------------------------------------------------------------------------- */
/* 1. Static checks                                                            */
/* -------------------------------------------------------------------------- */
async function staticChecks() {
  section('Static checks');

  await check('module file exists', () => {
    assert(existsSync(MODULE_PATH), `missing ${MODULE_PATH}`);
  });

  await check('module parses (node --check)', () => {
    const run = spawnSync(process.execPath, ['--check', MODULE_PATH], { encoding: 'utf8' });
    assert(run.status === 0, (run.stderr || run.stdout || 'node --check failed').trim());
  });

  await check('module registers the payment-requests view through SF.registerView', () => {
    const registered = [];
    const sandbox = loadSandbox({
      SF: {
        registerView(def) { registered.push(def); },
        helpers: {},
        db: {},
        ui: {}
      }
    });
    assert(sandbox, 'sandbox load failed');
    eq(registered.length, 1, 'registerView calls');
    const def = registered[0];
    eq(def.id, 'payment-requests', 'view id');
    eq(def.nav && def.nav.section, 'project', 'nav section');
    eq(def.nav && def.nav.icon, '🧾', 'nav icon');
    assert(def.nav && def.nav.label && def.nav.labelAr, 'nav label/labelAr required (EN/AR)');
    assert(typeof def.render === 'function', 'render(el) required');
    eq(JSON.stringify(def.roles && def.roles.slice().sort()), JSON.stringify(['controller', 'director', 'super']), 'view roles');
  });

  await check('module exports the required pure functions', () => {
    const api = loadPureApi();
    for (const fn of ['computeRetention', 'computeNet', 'computeAgeing', 'nextReference', 'validate']) {
      assert(typeof api[fn] === 'function', `window.SF_modules["payment-requests"].${fn} missing`);
    }
    assert(typeof api.buildPrintHtml === 'function', 'buildPrintHtml export missing');
  });

  await check('module uses the bridge surfaces the contract requires', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    for (const needle of [
      'selectStrict', 'openFormModal', 'canManage', 'db.log', 'safeImgSrc', 'h.esc',
      MIGRATION_FILE, 'actionButton(\'approve\'', 'win.opener = null', 'win.close()'
    ]) {
      matches(source, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `module source missing ${needle}`);
    }
    assert(/window\.SF_modules\[MODULE_ID\]\s*=\s*api/.test(source), 'window.SF_modules export missing');
  });

  await check('migration file exists with the exact contract filename', () => {
    assert(existsSync(MIGRATION_PATH), `missing ${MIGRATION_PATH}`);
    assert(MIGRATION_PATH.endsWith('/' + MIGRATION_FILE), 'unexpected migration filename');
  });

  await check('migration is idempotent (if not exists / create or replace / drop policy before create)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    matches(sql, /create table if not exists public\.payment_requests/i, 'create table if not exists');
    matches(sql, /create index if not exists/i, 'create index if not exists');
    matches(sql, /create or replace function public\.sf_current_role/i, 'create or replace sf_current_role');
    const drops = (sql.match(/drop policy if exists/gi) || []).length;
    assert(drops >= 4, `expected >= 4 "drop policy if exists" statements, found ${drops}`);
    assert((sql.match(/create policy/gi) || []).length >= 4, 'expected 4 create policy statements');
    matches(sql, /drop trigger if exists[^;]*payment_requests/i, 'drop trigger if exists before create trigger');
    matches(sql, /create trigger[^;]*payment_requests/i, 'compute-amounts trigger missing');
    // No destructive statements outside the rollback comment block.
    const destructive = sql.split('\n').filter((line) => !/^\s*--/.test(line) && /^\s*(drop table|truncate|alter table[^;]*drop column)/i.test(line));
    assert(destructive.length === 0, 'migration must not drop/truncate existing objects: ' + destructive.join(' | '));
  });

  await check('migration defines the full data model, checks and RLS', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    for (const column of [
      'project_id', 'party_id', 'request_type', 'reference', 'description', 'amount_aed',
      'retention_pct', 'retention_aed', 'advance_recovery_aed', 'net_aed', 'due_date',
      'status', 'requested_by', 'approved_by', 'approved_at', 'rejected_reason',
      'paid_at', 'payment_method', 'notes', 'created_at'
    ]) {
      matches(sql, new RegExp('\\b' + column + '\\b'), `missing column ${column}`);
    }
    matches(sql, /check \(request_type in \('subcontractor','supplier'\)\)/i, 'request_type check');
    matches(sql, /check \(status in \('draft','submitted','approved','rejected','paid'\)\)/i, 'status check');
    matches(sql, /check \(amount_aed > 0\)/i, 'amount_aed > 0 check');
    matches(sql, /check \(net_aed >= 0\)/i, 'net_aed >= 0 check');
    matches(sql, /unique \(project_id, reference\)/i, 'unique (project_id, reference)');
    matches(sql, /enable row level security/i, 'RLS not enabled');
    matches(sql, /for select to authenticated/i, 'select policy for authenticated');
    assert((sql.match(/"'director','controller','super'"/g) || sql.match(/'director','controller','super'/g) || []).length >= 3,
      'insert/update/delete policies must allow director/controller/super');
  });

  await check('docs/modules/payment-requests.md documents the module', () => {
    assert(existsSync(DOC_PATH), `missing ${DOC_PATH}`);
    const doc = readFileSync(DOC_PATH, 'utf8');
    for (const needle of ['payment_requests', 'net_aed', 'overdue', 'PR-001', 'ageing', 'RLS', MIGRATION_FILE]) {
      assert(doc.indexOf(needle) >= 0, `docs missing "${needle}"`);
    }
  });

  await check('tools/lib/testkit.mjs availability is reported, not silently skipped', () => {
    const present = existsSync(TESTKIT_PATH);
    return present ? 'testkit present — integration layer enabled' : 'testkit absent — integration layer skipped (static + pure checks still run)';
  });
}

/* -------------------------------------------------------------------------- */
/* 2. Pure calculation checks                                                  */
/* -------------------------------------------------------------------------- */
async function pureChecks() {
  section('Retention / net math (exact to 2dp)');
  const api = loadPureApi();

  await check('1000 @ 2.5% → retention 25.00, net 975.00', () => {
    eq(api.computeRetention(1000, 2.5), 25, 'retention(1000, 2.5%)');
    eq(api.computeNet(1000, api.computeRetention(1000, 2.5), 0), 975, 'net');
  });

  await check('333.33 @ 7.5% → retention 25.00, net 308.33', () => {
    eq(api.computeRetention(333.33, 7.5), 25, 'retention(333.33, 7.5%)');
    eq(api.computeNet(333.33, 25, 0), 308.33, 'net');
  });

  await check('rounds half away from zero at 2dp (0.025 → 0.03)', () => {
    eq(api.computeRetention(1, 2.5), 0.03, 'retention(1, 2.5%)');
    eq(api.computeRetention(0.05, 10), 0.01, 'retention(0.05, 10%)');
    eq(api.round2(2.675), 2.68, 'round2(2.675)');
  });

  await check('advance recovery is deducted from net', () => {
    eq(api.computeNet(1000, 100, 50), 850, 'net(1000, ret 100, adv 50)');
    eq(api.computeTotals({ amount_aed: 333.33, retention_pct: 7.5, advance_recovery_aed: 25.5 }).net_aed, 282.83, 'totals net');
  });

  await check('object signatures agree with positional signatures', () => {
    eq(api.computeRetention({ amount_aed: 1000, retention_pct: 2.5 }), 25, 'object retention');
    eq(api.computeNet({ amount_aed: 1000, retention_pct: 2.5 }), 975, 'object net with pct');
    eq(api.computeNet({ amount_aed: 1000, retention_aed: 100, advance_recovery_aed: 50 }), 850, 'object net with amounts');
    eq(api.computeNet(1000, { retention_pct: 2.5, advance_recovery_aed: 0 }), 975, 'mixed net');
  });

  section('Validation');
  await check('rejects negative net payable', () => {
    const result = api.validate({ amount_aed: 1000, retention_pct: 10, advance_recovery_aed: 950 });
    eq(result.ok, false, 'ok');
    assert(result.errors.join(' ').toLowerCase().indexOf('net amount cannot be negative') >= 0, 'error must mention negative net: ' + result.errors.join(' '));
    eq(result.values.net_aed, -50, 'computed net');
  });

  await check('accepts net of exactly zero (retention + recovery exhaust amount)', () => {
    const result = api.validate({ amount_aed: 1000, retention_pct: 10, advance_recovery_aed: 900 });
    eq(result.ok, true, 'ok: ' + result.errors.join(' '));
    eq(result.values.net_aed, 0, 'net');
    eq(result.values.retention_aed, 100, 'retention');
  });

  await check('rejects non-positive amount, out-of-range retention and negative advance', () => {
    eq(api.validate({ amount_aed: 0 }).ok, false, 'amount 0');
    eq(api.validate({ amount_aed: 100, retention_pct: 101 }).ok, false, 'retention 101');
    eq(api.validate({ amount_aed: 100, retention_pct: -1 }).ok, false, 'retention -1');
    eq(api.validate({ amount_aed: 100, advance_recovery_aed: -5 }).ok, false, 'advance -5');
  });

  await check('rejects a duplicate reference (case-insensitive)', () => {
    const dup = api.validate({ amount_aed: 100, reference: 'PR-001' }, { existingReferences: ['pr-001', 'PR-002'] });
    eq(dup.ok, false, 'duplicate ref ok');
    assert(dup.errors.join(' ').indexOf('already used') >= 0, 'duplicate ref error message');
    const ok = api.validate({ amount_aed: 100, reference: 'PR-003' }, { existingReferences: ['PR-001', 'PR-002'] });
    eq(ok.ok, true, 'fresh ref ok');
  });

  await check('validate returns rounded values to persist', () => {
    const result = api.validate({ amount_aed: 333.33, retention_pct: 7.5, advance_recovery_aed: 0 });
    eq(result.values.amount_aed, 333.33, 'amount');
    eq(result.values.retention_pct, 7.5, 'pct');
    eq(result.values.retention_aed, 25, 'retention');
    eq(result.values.net_aed, 308.33, 'net');
  });

  section('Reference sequencing');
  await check('nextReference derives max trailing number + 1', () => {
    eq(api.nextReference([]), 'PR-001', 'empty project');
    eq(api.nextReference(['PR-001', 'PR-002']), 'PR-003', 'sequential');
    eq(api.nextReference(['PR-009', 'PR-010', 'PR-002']), 'PR-011', 'non-ordered refs');
    eq(api.nextReference(['PR-009', 'PR-100']), 'PR-101', 'max not last');
    eq(api.nextReference([{ reference: 'PR-004' }, { reference: 'PR-002' }]), 'PR-005', 'rows with .reference');
    eq(api.nextReference(['INV-77']), 'PR-078', 'unrelated prefix still parses trailing digits');
    eq(api.nextReference(['PR-999']), 'PR-1000', 'pads to at least 3 digits');
  });

  await check('nextReference is collision-safe against the current set', () => {
    const refs = ['PR-001', 'PR-002', 'PR-005'];
    const next = api.nextReference(refs);
    assert(refs.indexOf(next) < 0, `next reference ${next} already exists`);
    eq(next, 'PR-006', 'next');
  });

  section('Ageing buckets (today = 2026-11-03)');
  const ageingCase = (due, status, expectedBucket, expectedDays) => {
    const result = api.computeAgeing({ due_date: due, status: status || 'submitted' }, TODAY);
    eq(result.bucket, expectedBucket, `${due} (${status || 'submitted'}) bucket`);
    if (expectedDays !== undefined) eq(result.daysOverdue, expectedDays, `${due} daysOverdue`);
    return result;
  };
  await check('not due: due today and future dates', () => {
    const today = ageingCase('2026-11-03', 'submitted', 'not_due');
    eq(today.overdue, false, 'due-today overdue');
    eq(today.daysUntilDue, 0, 'due-today daysUntilDue');
    const future = ageingCase('2026-11-10', 'approved', 'not_due');
    eq(future.overdue, false, 'future overdue');
    eq(future.daysUntilDue, 7, 'future daysUntilDue');
  });

  await check('1-30 bucket boundaries (1 and 30 days past due)', () => {
    const one = ageingCase('2026-11-02', 'submitted', '1-30', 1);
    eq(one.overdue, true, '1 day overdue');
    ageingCase('2026-10-04', 'submitted', '1-30', 30);
  });

  await check('31-60 bucket boundaries (31 and 60 days past due)', () => {
    ageingCase('2026-10-03', 'submitted', '31-60', 31);
    ageingCase('2026-09-04', 'submitted', '31-60', 60);
  });

  await check('61-90 bucket boundaries (61 and 90 days past due)', () => {
    ageingCase('2026-09-03', 'submitted', '61-90', 61);
    ageingCase('2026-08-05', 'submitted', '61-90', 90);
  });

  await check('90+ bucket starts at 91 days past due', () => {
    ageingCase('2026-08-04', 'submitted', '90+', 91);
  });

  await check('paid / rejected are closed and never overdue', () => {
    const paid = ageingCase('2026-01-01', 'paid', 'closed');
    eq(paid.overdue, false, 'paid overdue');
    const rejected = ageingCase('2026-01-01', 'rejected', 'closed');
    eq(rejected.overdue, false, 'rejected overdue');
  });

  await check('missing due date is not overdue', () => {
    const result = api.computeAgeing({ status: 'submitted' }, TODAY);
    eq(result.bucket, 'no_due', 'bucket');
    eq(result.overdue, false, 'overdue');
  });

  await check('ageingSummary aggregates counts and net values per bucket', () => {
    const rows = [
      { due_date: '2026-11-02', status: 'submitted', net_aed: 100 },
      { due_date: '2026-10-03', status: 'submitted', net_aed: 50 },
      { due_date: '2026-11-03', status: 'approved', net_aed: 25 },
      { due_date: '2026-01-01', status: 'paid', net_aed: 999 },
      { due_date: '2026-09-03', status: 'submitted', net_aed: 10 }
    ];
    const summary = api.ageingSummary(rows, TODAY);
    eq(summary['1-30'].count, 1, '1-30 count');
    eq(summary['1-30'].value, 100, '1-30 value');
    eq(summary['31-60'].count, 1, '31-60 count');
    eq(summary['61-90'].count, 1, '61-90 count');
    eq(summary.not_due.count, 1, 'not_due count');
    eq(summary.closed.count, 1, 'closed count');
    eq(summary.overdue.count, 3, 'overdue count');
    eq(summary.overdue.value, 160, 'overdue value');
    eq(summary.total.value, 1184, 'total value');
  });

  section('Print document escaping + direction');
  const printRow = {
    id: 'row-1', reference: 'PR-007', party_id: 'party-1', request_type: 'subcontractor',
    description: '<b>Works</b> & extras', amount_aed: 1000, retention_pct: 2.5,
    retention_aed: 25, advance_recovery_aed: 0, net_aed: 975, due_date: '2026-11-30',
    status: 'submitted', requested_by: 'Requested By <script>alert(2)</script>',
    approved_by: '', approved_at: null, rejected_reason: '', paid_at: null,
    payment_method: '', notes: ''
  };
  const hostileParty = { id: 'party-1', type: 'subcontractor', name: '<script>alert(1)</script>', companyName: '', contactPerson: '', phone: '', email: '', address: '' };
  const ctxEn = {
    company: { name: 'Al Nakheel <Contracting>', address: 'Dubai', tax_id: '100234567800003', logo_data: 'javascript:alert(9)' },
    project: { name: 'Al Barsha G+M Warehouse', code: 'PRJ-001' },
    parties: [hostileParty], language: 'en', today: TODAY
  };

  await check('print HTML escapes a party name containing <script>', () => {
    const html = api.buildPrintHtml(printRow, ctxEn);
    assert(html.indexOf('<script>alert(1)</script>') < 0, 'raw <script> party name leaked into print HTML');
    assert(html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') >= 0, 'party name was not escaped');
    assert(html.indexOf('<script>alert(2)</script>') < 0, 'raw <script> requester leaked');
    assert(html.indexOf('&lt;b&gt;Works&lt;/b&gt;') >= 0, 'description not escaped');
    assert(html.indexOf('PR-007') >= 0, 'reference missing from print');
  });

  await check('print HTML drops unsafe logo URLs and keeps branding', () => {
    const html = api.buildPrintHtml(printRow, ctxEn);
    assert(!/javascript:/i.test(html), 'javascript: logo URL leaked into print HTML');
    assert(html.indexOf('&lt;Contracting&gt;') >= 0, 'company name not escaped/present');
    assert(html.indexOf('100234567800003') >= 0, 'company tax id missing');
    assert(html.indexOf('AED 1,000.00') >= 0, 'gross amount missing');
    assert(html.indexOf('AED 975.00') >= 0, 'net amount missing');
    assert(html.indexOf('Requested by') >= 0 || html.indexOf('Requested by') >= 0, 'signature labels missing');
  });

  await check('print HTML is dir-aware for Arabic', () => {
    const htmlAr = api.buildPrintHtml(printRow, Object.assign({}, ctxEn, { language: 'ar' }));
    assert(/<html lang="ar" dir="rtl"/.test(htmlAr), 'Arabic document must set dir="rtl"');
    assert(htmlAr.indexOf('طلب دفع') >= 0, 'Arabic document title missing');
    const htmlEn = api.buildPrintHtml(printRow, ctxEn);
    assert(/<html lang="en" dir="ltr"/.test(htmlEn), 'English document must set dir="ltr"');
  });
}

/* -------------------------------------------------------------------------- */
/* 3. Integration checks (only when the shared testkit has landed)             */
/* -------------------------------------------------------------------------- */
async function integrationChecks() {
  if (!existsSync(TESTKIT_PATH)) {
    section('Integration (testkit absent)');
    console.log('  – skipped: tools/lib/testkit.mjs is not on disk yet.');
    console.log('    Re-run once harness-builder delivers it; the pure + static checks above are the current gate.');
    return;
  }
  const kit = await import(pathToFileURL(TESTKIT_PATH).href);
  if (typeof kit.withApp !== 'function') {
    section('Integration (testkit incomplete)');
    console.log('  ! tools/lib/testkit.mjs exists but does not export withApp(); skipping integration layer.');
    return;
  }
  section('Integration (headless, mock Supabase)');
  await runViewChecks(kit);
}

// Seed rows in the mock database (fixture shape of the migration, not the
// harness's legacy placeholder fixtures) and drive the real view.
const PROJECT_A = 'c0000000-0000-4000-8000-000000000001';
const SUBCONTRACTOR_PARTY = 'c0000000-0000-4000-8000-000000000023';
const SUPPLIER_PARTY = 'c0000000-0000-4000-8000-000000000024';
const SEED_ROWS = [
  {
    id: 'a1000000-0000-4000-8000-000000000041', project_id: PROJECT_A, party_id: SUBCONTRACTOR_PARTY,
    request_type: 'subcontractor', reference: 'PR-001', description: 'Electrical first fix - milestone 1',
    amount_aed: 185000, retention_pct: 5, retention_aed: 9250, advance_recovery_aed: 0, net_aed: 175750,
    due_date: '2026-10-04', status: 'submitted', requested_by: 'Sanjay Menon', approved_by: null,
    approved_at: null, rejected_reason: null, paid_at: null, payment_method: null, notes: null,
    created_at: '2026-10-01T08:00:00.000Z'
  },
  {
    id: 'a1000000-0000-4000-8000-000000000042', project_id: PROJECT_A, party_id: SUPPLIER_PARTY,
    request_type: 'supplier', reference: 'PR-002', description: 'Concrete supply - September statement',
    amount_aed: 96500, retention_pct: 0, retention_aed: 0, advance_recovery_aed: 0, net_aed: 96500,
    due_date: '2026-11-30', status: 'approved', requested_by: 'Omar Farooq', approved_by: 'Fatima Al Mansoori',
    approved_at: '2026-10-20T09:30:00.000Z', rejected_reason: null, paid_at: null, payment_method: null,
    notes: null, created_at: '2026-10-15T08:00:00.000Z'
  },
  {
    id: 'a1000000-0000-4000-8000-000000000043', project_id: PROJECT_A, party_id: SUBCONTRACTOR_PARTY,
    request_type: 'subcontractor', reference: 'PR-003', description: 'Plumbing rough-in - milestone 1',
    amount_aed: 74000, retention_pct: 5, retention_aed: 3700, advance_recovery_aed: 2000, net_aed: 68300,
    due_date: '2026-09-01', status: 'paid', requested_by: 'Sanjay Menon', approved_by: 'Fatima Al Mansoori',
    approved_at: '2026-09-05T09:30:00.000Z', rejected_reason: null, paid_at: '2026-09-12T12:00:00.000Z',
    payment_method: 'Bank Transfer', notes: null, created_at: '2026-09-01T08:00:00.000Z'
  }
];

const VIEW_STATE_EXPRESSION = `(() => {
  const api = window.SF_modules && window.SF_modules['payment-requests'];
  const main = document.getElementById('main');
  return {
    view: (window.SF && window.SF.ui && window.SF.ui.hasView) ? window.SF.ui.hasView('payment-requests') : null,
    api: !!api,
    root: !!document.getElementById('prRoot'),
    html: main ? main.innerHTML : ''
  };
})()`;

async function runViewChecks(kit) {
  // Boot the real app as the given role with the payment_requests fixture table
  // matching the migration schema, open project A, then drive the module view.
  const runWithRole = async (role, fn) => {
    return kit.withApp(
      { role, project: 0, fixtureOverrides: { payment_requests: SEED_ROWS } },
      async (app) => {
        app.diagnostics.clear(); // ignore boot-time noise from unrelated views
        await app.goView('payment-requests');
        await app.waitFor(async () => {
          const state = await app.evaluate(VIEW_STATE_EXPRESSION);
          return !!(state.root && state.html.indexOf('PR-001') >= 0);
        }, { label: 'payment-requests rows to render' });
        const state = await app.evaluate(VIEW_STATE_EXPRESSION);
        return fn(app, state);
      }
    );
  };
  const consoleErrors = (app) => (app.diagnostics && Array.isArray(app.diagnostics.errors)) ? app.diagnostics.errors : [];

  await check('director: payment-requests view renders seeded rows with approve/pay/delete actions', async () => {
    await runWithRole('director', async (app, state) => {
      assert(state.api, 'module API missing on window.SF_modules["payment-requests"]');
      assert(state.view === true, 'director must be allowed to open payment-requests');
      assert(state.root === true, '#prRoot not rendered');
      assert(state.html.indexOf('PR-001') >= 0, 'seeded reference PR-001 missing from the rendered view');
      assert(state.html.indexOf('PR-002') >= 0, 'seeded reference PR-002 missing from the rendered view');
      assert(state.html.indexOf('data-pr-action="approve"') >= 0, 'director must see approve buttons for submitted requests');
      assert(state.html.indexOf('data-pr-action="reject"') >= 0, 'director must see reject buttons for submitted requests');
      assert(state.html.indexOf('data-pr-action="pay"') >= 0, 'director must see mark-paid for approved requests');
      assert(state.html.indexOf('data-pr-action="delete"') >= 0, 'director must see delete buttons');
      const errors = consoleErrors(app);
      assert(errors.length === 0, 'console errors while rendering: ' + errors.join(' | '));
    });
  });

  await check('super: payment-requests view renders but has no approve/reject/pay/delete actions', async () => {
    await runWithRole('super', async (app, state) => {
      assert(state.view === true, 'super must be allowed to open payment-requests');
      assert(state.html.indexOf('PR-001') >= 0, 'super must see the seeded rows');
      assert(state.html.indexOf('data-pr-action="approve"') < 0, 'super must NOT see approve buttons');
      assert(state.html.indexOf('data-pr-action="reject"') < 0, 'super must NOT see reject buttons');
      assert(state.html.indexOf('data-pr-action="pay"') < 0, 'super must NOT see mark-paid buttons');
      assert(state.html.indexOf('data-pr-action="delete"') < 0, 'super must NOT see delete buttons');
      assert(state.html.indexOf('data-pr-action="print"') >= 0, 'super should still be able to print');
      const errors = consoleErrors(app);
      assert(errors.length === 0, 'console errors while rendering: ' + errors.join(' | '));
    });
  });

  await check('live module: print HTML escapes a hostile party name', async () => {
    await runWithRole('director', async (app) => {
      const escaped = await app.evaluate(`(() => {
        const api = window.SF_modules && window.SF_modules['payment-requests'];
        if (!api) return { hasRaw: true, hasEscaped: false, reason: 'NO_API' };
        const html = api.buildPrintHtml({
          reference: 'PR-007', party_id: 'x1', request_type: 'subcontractor', description: 'Works',
          amount_aed: 1000, retention_pct: 2.5, retention_aed: 25, advance_recovery_aed: 0, net_aed: 975,
          due_date: '2026-11-30', status: 'submitted', requested_by: 'Tester'
        }, { company: { name: 'Test Co' }, project: { name: 'P' }, language: 'en',
             parties: [{ id: 'x1', type: 'subcontractor', name: '<script>alert(1)</script>' }] });
        return {
          hasRaw: html.indexOf('<script>alert(1)</script>') >= 0,
          hasEscaped: html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') >= 0,
          hasDir: /<html lang="en" dir="ltr"/.test(html)
        };
      })()`);
      assert(escaped && escaped.hasRaw === false, 'live print HTML leaked a raw <script> party name');
      assert(escaped && escaped.hasEscaped === true, 'live print HTML did not escape the party name');
      assert(escaped && escaped.hasDir === true, 'live print HTML is not direction-aware');
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */
async function main() {
  console.log('\nPayment Requests module checks\n================================');
  await staticChecks();
  await pureChecks();
  await integrationChecks();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} failed` : ''}\n`);
  if (failed) {
    console.log('Failures:');
    for (const failure of results.filter((r) => !r.ok)) {
      console.log(`  - [${failure.section}] ${failure.name}: ${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nCheck harness failure:', error);
  process.exitCode = 1;
});
