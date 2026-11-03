#!/usr/bin/env node
// Payslips module checks — runnable with `node tools/checks/payslips.mjs`.
//
// Three layers, each independent so the file is useful before the headless
// harness is ready and stricter once it is:
//   1. Static:  files exist, JS parses, migration is idempotent + RLS-wired,
//               doc mentions the migration, view/test-surface contracts.
//   2. Pure:    the module is loaded in a node:vm sandbox with a fake `window.SF`
//               and the exact money rules, clamping, worker-note parsing,
//               grouping and print escaping are asserted directly.
//   3. Headless (when tools/lib/testkit.mjs is present): boots the real app in
//               headless Chrome against the mock Supabase, signs in as director,
//               opens the Payslips view, generates a batch from approved
//               timesheets, saves twice (idempotency), prints and walks the
//               draft → approved → paid flow with zero JS exceptions.
//
// Zero npm dependencies. Node >= 20.

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE_PATH = resolve(ROOT, 'scripts/modules/payslips.js');
const MIGRATION_PATH = resolve(ROOT, 'supabase/migrations/202611031003_payslips.sql');
const DOC_PATH = resolve(ROOT, 'docs/modules/payslips.md');
const MIGRATION_REL = 'supabase/migrations/202611031003_payslips.sql';
const TESTKIT_PATH = resolve(ROOT, 'tools/lib/testkit.mjs');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? '\n      ' + String(detail).split('\n').join('\n      ') : ''}`);
}
async function test(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (error) {
    record(name, false, error && error.message ? error.message : String(error));
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function close(actual, expected, label, tolerance = 0.0001) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------ *
 * Layer 1 + 2 — static + pure (no browser)                           *
 * ------------------------------------------------------------------ */
function makeFakeDocument() {
  function makeElement() {
    return {
      style: {},
      innerHTML: '',
      textContent: '',
      setAttribute() {},
      appendChild() {},
      removeChild() {},
      focus() {},
      contentWindow: { document: { open() {}, write() {}, close() {} }, focus() {}, print() {} }
    };
  }
  return {
    getElementById: () => null,
    createElement: () => makeElement(),
    body: { appendChild() {}, removeChild() {}, contains: () => true }
  };
}

/** Load scripts/modules/payslips.js in an isolated vm context with a fake bridge. */
async function loadModuleInVm() {
  const source = await readFile(MODULE_PATH, 'utf8');
  const views = {};
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const company = { id: 'co-1', name: 'Al Nakheel Contracting LLC', address: 'Warehouse 12, Al Quoz, Dubai', phone: '+971 4 555 0192', email: 'accounts@example.ae', tax_id: '100234567800003', logo_data: null };
  const state = { company, projects: [], timesheets: [], workers: [], currentProjectId: 'project-1', currentProject: { id: 'project-1', code: 'PRJ-001' } };
  const SF = {
    helpers: {
      esc,
      t: (k) => k,
      money: (n) => (Number(n) < 0 ? '-AED ' : 'AED ') + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      money0: (n) => 'AED ' + Math.round(Number(n) || 0),
      num: (n, d) => (Number(n) || 0).toFixed(d != null ? d : 2),
      numOr: (v, f) => {
        if (v === null || v === undefined || v === '') return f;
        const n = Number(v);
        return Number.isNaN(n) ? f : n;
      },
      fmtDate: (v) => String(v || '—'),
      today: () => '2026-11-03',
      toLocalDate: (v) => new Date(v),
      daysUntil: () => 0,
      safeImgSrc: (src) => (src ? String(src) : ''),
      parsePhotos: () => [],
      genUUID: () => '00000000-0000-4000-8000-000000000001'
    },
    db: {
      selectStrict: async () => ({ rows: [], error: null }),
      select: async () => [],
      insert: async () => ({}),
      update: async () => true,
      remove: async () => true,
      upsert: async () => ({ data: null, error: null }),
      log: async () => {},
      client: () => null,
      isReady: () => true
    },
    ui: {
      toast: () => {},
      openModal: () => {},
      closeModal: () => {},
      openFormModal: () => {},
      render: () => {},
      canManage: () => true,
      hasView: () => true,
      goView: () => {}
    },
    data: { state },
    registerView: (def) => { views[def && def.id] = def; },
    language: 'en',
    user: { id: 'u-1', name: 'Director', role: 'director' },
    company,
    currentProject: state.currentProject,
    currentProjectId: state.currentProjectId,
    parties: []
  };
  const sandbox = {
    window: {
      SF,
      SF_modules: undefined,
      open: () => null,
      confirm: () => true,
      crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000002' }
    },
    document: makeFakeDocument(),
    setTimeout,
    clearTimeout,
    console
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'scripts/modules/payslips.js' });
  const api = sandbox.window.SF_modules && sandbox.window.SF_modules.payslips;
  assert(api, 'module did not expose window.SF_modules.payslips');
  return { api, view: views.payslips, SF, sandbox, state, source };
}

function fakeEl() {
  return {
    innerHTML: '',
    querySelector(selector) { return selector === '[data-ps-root]' ? {} : null; }
  };
}

async function staticChecks() {
  console.log('\nPayslips — static checks');
  await test('module file exists and parses (node --check)', async () => {
    const info = await stat(MODULE_PATH);
    assert(info.isFile() && info.size > 4000, `payslips.js too small (${info.size} B) — placeholder left in place?`);
    const { checkJsSyntax } = await import('../lib/cdp.mjs');
    const error = checkJsSyntax(MODULE_PATH);
    assert(!error, error);
  });
  await test('migration exists with the exact required filename', async () => {
    const info = await stat(MIGRATION_PATH);
    assert(info.isFile() && info.size > 1000, 'migration file missing or too small');
  });
  await test('migration is idempotent (if-not-exists + policy drops)', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert(/create table if not exists public\.payslips/i.test(sql), 'create table if not exists missing');
    assert(/create unique index if not exists payslips_project_worker_period_uidx/i.test(sql), 'unique(project_id,worker_id,period) index missing');
    assert(/create index if not exists/i.test(sql), 'secondary indexes should use if not exists');
    assert(/create or replace function public\.sf_current_role\(\)/i.test(sql), 'sf_current_role helper missing');
    for (const policy of ['payslips_select', 'payslips_insert', 'payslips_update', 'payslips_delete']) {
      assert(new RegExp('drop policy if exists ' + policy, 'i').test(sql), `drop-policy-if-exists missing for ${policy}`);
      assert(new RegExp('create policy ' + policy, 'i').test(sql), `create policy missing for ${policy}`);
    }
    assert(/alter table public\.payslips enable row level security/i.test(sql), 'RLS not enabled');
    assert(/rollback/i.test(sql), 'header should document rollback');
  });
  await test('migration has the contracted columns, checks and FKs', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    const flat = sql.toLowerCase().replace(/\s+/g, ' ');
    for (const column of ['project_id uuid', 'worker_id uuid', 'worker_name text', 'staff_no text', 'period text', 'days_worked numeric(6,2)', 'reg_hours numeric(8,2)', 'ot_hours numeric(8,2)', 'hourly_rate_aed numeric(10,2)', 'ot_rate_aed numeric(10,2)', 'gross_aed numeric(14,2)', 'loan_deduction_aed numeric(14,2)', 'other_deductions_aed numeric(14,2)', 'net_aed numeric(14,2)', 'status text', 'paid_at timestamptz', 'notes text', 'created_at timestamptz']) {
      assert(flat.includes(column.toLowerCase()), `column missing: ${column}`);
    }
    assert(/references public\.projects\(id\) on delete cascade/i.test(sql), 'project_id must cascade');
    assert(/references public\.workers\(id\)/i.test(sql), 'worker_id must reference workers');
    assert(/status in \('draft','approved','paid'\)/i.test(sql), 'status check must allow draft/approved/paid');
    assert(/period ~ '\^\[0-9\]\{4\}-/i.test(sql), 'period should be validated as YYYY-MM');
    assert(/gen_random_uuid\(\)/i.test(sql), 'uuid PK default missing');
    assert(/sf_current_role\(\) in \('director','controller'\)/i.test(sql), 'write policies must be manager-only');
  });
  await test('module registers the payslips view with a manager-only role gate', async () => {
    const source = await readFile(MODULE_PATH, 'utf8');
    assert(/if \(!window\.SF\) return;/.test(source), 'module must no-op when the SF bridge is absent');
    assert(/id: VIEW_ID/.test(source) && /var VIEW_ID = 'payslips'/.test(source), 'view id payslips missing');
    assert(/roles: \['director', 'controller'\]/.test(source), 'view roles must be director/controller');
    assert(/nav: \{ section: 'project'/.test(source), 'nav must be a project-section entry');
    assert(/canManage/.test(source), 'manager guards missing');
    assert(!/\bwindow\.supabase\b/.test(source), 'module must use SF.db, not the raw global');
    assert(source.includes('page-break-after:always'), 'print CSS must break pages between payslips');
    assert(source.includes('w.opener = null'), 'print window must sever opener');
    assert(source.includes('w.print()'), 'print window must call print()');
  });
  await test('docs/modules/payslips.md documents the module', async () => {
    const doc = await readFile(DOC_PATH, 'utf8');
    assert(doc.includes(MIGRATION_REL), 'doc must name the migration file');
    assert(/ot_rate|OT rate/i.test(doc), 'doc must state the OT rule');
    assert(/loan/i.test(doc) && /shortfall/i.test(doc), 'doc must state the loan/shortfall rule');
    assert(/node tools\/checks\/payslips\.mjs/.test(doc), 'doc must document how to run the checks');
    assert(/upsert/i.test(doc), 'doc must explain idempotent upsert');
    assert(/page-break|one payslip per page/i.test(doc), 'doc must explain print pagination');
  });
}

function pureChecks(api) {
  console.log('\nPayslips — calculation rules (pure)');
  test('OT rate is exactly 1.5 × hourly rate, rounded to 2dp', () => {
    eq(api.otRate(25), 37.5, 'otRate(25)');
    eq(api.otRate(0), 0, 'otRate(0)');
    eq(api.otRate(-10), 0, 'otRate(-10) clamps to 0');
    eq(api.otRate(26.67), 40.01, 'otRate(26.67) rounds to 40.01');
  });
  test('gross/net: 8h @ 25 + 2h OT => 200 + 75 = 275.00', () => {
    const line = api.computeLine({ hourly_rate: 25, reg_hours: 8, ot_hours: 2 });
    eq(line.ot_rate, 37.5, 'ot_rate');
    eq(line.gross, 275, 'gross');
    eq(line.loan_deduction, 0, 'loan deduction');
    eq(line.other_deductions, 0, 'other deductions');
    eq(line.net, 275, 'net');
    eq(line.shortfall, 0, 'shortfall');
  });
  test('rounding stays exact to 2dp under binary-hostile rates', () => {
    const line = api.computeLine({ hourly_rate: 26.67, reg_hours: 8, ot_hours: 1 });
    eq(line.hourly_rate, 26.67, 'rate');
    eq(line.ot_rate, 40.01, 'ot rate');
    eq(line.gross, 253.37, 'gross = 213.36 + 40.01');
    eq(line.net, 253.37, 'net');
    eq(api.round2(1.005), 1.01, 'round2(1.005)');
    eq(api.round2(2.675), 2.68, 'round2(2.675)');
  });
  test('loan deduction is capped at gross and the shortfall is recorded', () => {
    const line = api.computeLine({ hourly_rate: 10, reg_hours: 10, ot_hours: 0, loan_balance: 500 });
    eq(line.gross, 100, 'gross');
    eq(line.loan_deduction, 100, 'loan capped at gross');
    eq(line.net, 0, 'net floor 0');
    eq(line.shortfall, 400, 'shortfall = 500 - 100');
    const notes = api.notesForLine(line, '2026-11');
    assert(/Loan shortfall: AED 400\.00/.test(notes), 'notes must record the shortfall amount: ' + notes);
    assert(/carried forward/i.test(notes), 'notes must say the remainder carries forward');
  });
  test('loan smaller than gross is fully deducted; another loan is not invented', () => {
    const line = api.computeLine({ hourly_rate: 25, reg_hours: 8, ot_hours: 2, loan_balance: 100 });
    eq(line.loan_deduction, 100, 'loan deduction');
    eq(line.net, 175, 'net = 275 - 100');
    eq(line.shortfall, 0, 'no shortfall');
    eq(api.computeLine({ hourly_rate: 25, reg_hours: 8, ot_hours: 2 }).loan_deduction, 0, 'no balance => no deduction');
  });
  test('other deductions never go below zero and net floors at 0', () => {
    const line = api.computeLine({ hourly_rate: 10, reg_hours: 10, loan_balance: 0, other_deductions: 150 });
    eq(line.other_deductions, 150, 'other deductions kept');
    eq(line.net, 0, 'net clamped to 0');
    const negative = api.computeLine({ hourly_rate: 10, reg_hours: 10, other_deductions: -75 });
    eq(negative.other_deductions, 0, 'negative other deductions clamped');
    assert(negative.warnings.length > 0, 'negative other deductions should warn');
  });
  test('negative hours are clamped to 0 and warned about, never silently accepted', () => {
    const line = api.computeLine({ hourly_rate: 25, reg_hours: -8, ot_hours: -2 });
    eq(line.reg_hours, 0, 'reg hours clamped');
    eq(line.ot_hours, 0, 'OT hours clamped');
    eq(line.gross, 0, 'gross');
    eq(line.net, 0, 'net');
    assert(line.warnings.some((w) => /clamped/i.test(w)), 'warning missing: ' + line.warnings.join('; '));
    const bad = api.computeLine({ hourly_rate: 'abc', reg_hours: 'xyz', ot_hours: null, loan_balance: 'nope', other_deductions: undefined, days_worked: -3 });
    eq(bad.reg_hours, 0, 'NaN reg hours');
    eq(bad.gross, 0, 'NaN gross');
    eq(bad.days_worked, 0, 'negative days clamped');
    eq(api.computeLine({ hourly_rate: -25, reg_hours: 8 }).hourly_rate, 0, 'negative rate clamped');
  });
  test('computeTotals sums a batch to 2dp', () => {
    const lines = [
      api.computeLine({ hourly_rate: 25, reg_hours: 8, ot_hours: 2 }),
      api.computeLine({ hourly_rate: 20, reg_hours: 8, ot_hours: 0, loan_balance: 50 }),
      api.computeLine({ hourly_rate: 15, reg_hours: 2, ot_hours: 0 })
    ];
    const totals = api.computeTotals(lines);
    eq(totals.count, 3, 'count');
    eq(totals.reg_hours, 18, 'reg hours');
    eq(totals.ot_hours, 2, 'OT hours');
    eq(totals.gross, 275 + 160 + 30, 'gross');
    eq(totals.loan_deduction, 50, 'loan');
    eq(totals.net, 275 + 110 + 30, 'net');
  });
  test('worker notes: packed sfpay JSON, legacy raw JSON, plain text and raw columns', () => {
    const packed = api.parseWorkerPay('<!--sfpay:{"salary":6500,"loan":4000,"deduct":800}-->\nForklift certified.');
    eq(packed.salary, 6500, 'packed salary');
    eq(packed.loan, 4000, 'packed loan');
    eq(packed.deduct, 800, 'packed deduct');
    eq(packed.notes, 'Forklift certified.', 'packed notes body');
    const legacy = api.parseWorkerPay('{"salary_aed":3200,"loan_balance":2500,"loan_deduction":500}');
    eq(legacy.salary, 3200, 'legacy salary');
    eq(legacy.loan, 2500, 'legacy loan');
    eq(legacy.deduct, 500, 'legacy deduct');
    const plain = api.parseWorkerPay('Renewal documents with PRO.');
    eq(plain.salary, 0, 'plain salary');
    eq(plain.notes, 'Renewal documents with PRO.', 'plain notes');
    const broken = api.parseWorkerPay('<!--sfpay:{oops}-->\nfallback text');
    eq(broken.loan, 0, 'broken JSON does not throw');
    const fromColumns = api.workerPayOf({ name: 'X', salary_aed: 100, loan_balance: 200, notes: 'plain' });
    eq(fromColumns.salary, 100, 'raw column salary fallback');
    eq(fromColumns.loan, 200, 'raw column loan fallback');
  });
  test('buildLines groups approved timesheets by worker and period, prunes the rest', () => {
    const workers = [
      { id: 'w1', name: 'Alice Dsouza', staff_no: 'EMP-9001', trade: 'CONC', nationality: 'Indian', notes: '<!--sfpay:{"salary":6500,"loan":5000,"deduct":800}-->\n' },
      { id: 'w2', name: 'Bob Okoro', staff_no: 'EMP-9002', trade: 'STEL', nationality: 'Nigerian', salary_aed: 3000, loan_balance: 0, notes: 'plain' }
    ];
    const timesheets = [
      { project_id: 'p1', employee_name: 'Alice Dsouza', work_date: '2026-11-01', reg_hours: 4, ot_hours: 1, rate_aed: 25, total_cost_aed: 137.5, status: 'approved' },
      { project_id: 'p1', employee_name: 'Alice Dsouza', work_date: '2026-11-02', reg_hours: 4, ot_hours: 1, rate_aed: 25, total_cost_aed: 137.5, status: 'approved' },
      { project_id: 'p1', employee_name: 'Bob Okoro', work_date: '2026-11-02', reg_hours: 8, ot_hours: 0, rate_aed: 20, total_cost_aed: 160, status: 'approved' },
      { project_id: 'p1', employee_name: 'Alice Dsouza', work_date: '2026-11-03', reg_hours: 8, ot_hours: 0, rate_aed: 25, total_cost_aed: 200, status: 'pending' },
      { project_id: 'p1', employee_name: 'Bob Okoro', work_date: '2026-10-15', reg_hours: 8, ot_hours: 0, rate_aed: 20, total_cost_aed: 160, status: 'approved' },
      { project_id: 'p1', employee_name: 'Ghost Worker', work_date: '2026-11-01', reg_hours: 2, ot_hours: 0, rate_aed: 15, total_cost_aed: 30, status: 'approved' }
    ];
    const lines = api.buildLines({ period: '2026-11', timesheets, workers });
    eq(lines.length, 3, 'one line per name for the period');
    const alice = lines.find((l) => l.worker_name === 'Alice Dsouza');
    eq(alice.reg_hours, 8, 'Alice reg hours');
    eq(alice.ot_hours, 2, 'Alice OT hours');
    eq(alice.days_worked, 2, 'Alice distinct days');
    eq(alice.hourly_rate, 25, 'Alice weighted rate');
    eq(alice.gross, 275, 'Alice gross');
    eq(alice.loan_deduction, 275, 'Alice loan capped at gross');
    eq(alice.net, 0, 'Alice net');
    eq(alice.shortfall, 4725, 'Alice shortfall');
    eq(alice.worker_id, 'w1', 'Alice matched worker id');
    const bob = lines.find((l) => l.worker_name === 'Bob Okoro');
    eq(bob.gross, 160, 'Bob gross');
    eq(bob.days_worked, 1, 'Bob only in-period day counts');
    eq(bob.worker_id, 'w2', 'Bob matched via exact name');
    const ghost = lines.find((l) => l.worker_name === 'Ghost Worker');
    eq(ghost.matched, false, 'unmatched name flagged');
    eq(ghost.worker_id, null, 'unmatched has no worker id');
    assert(ghost.warnings.some((w) => /matching worker/i.test(w)), 'unmatched warning missing');
  });
  test('buildLines falls back to monthly salary / 208 h when timesheets carry no rate', () => {
    const lines = api.buildLines({
      period: '2026-11',
      timesheets: [{ employee_name: 'Carol Diaz', work_date: '2026-11-01', reg_hours: 8, ot_hours: 0, rate_aed: 0, status: 'approved' }],
      workers: [{ id: 'w3', name: 'Carol Diaz', staff_no: 'EMP-9003', notes: '<!--sfpay:{"salary":4160,"loan":0,"deduct":0}-->' }]
    });
    eq(lines.length, 1, 'one line');
    eq(lines[0].hourly_rate, 20, '4160 / 208 = 20');
    eq(lines[0].gross, 160, 'gross');
    assert(lines[0].warnings.some((w) => /monthly salary/i.test(w)), 'salary fallback should warn');
  });
  test('buildLines can match by staff_no when the name differs', () => {
    const lines = api.buildLines({
      period: '2026-11',
      timesheets: [{ employee_name: 'A. Khan', staff_no: 'EMP-0007', work_date: '2026-11-01', reg_hours: 8, ot_hours: 0, rate_aed: 25, status: 'approved' }],
      workers: [{ id: 'w7', name: 'Ali Khan', staff_no: 'EMP-0007', notes: '' }]
    });
    eq(lines[0].worker_id, 'w7', 'matched by staff_no fallback');
  });
}

async function vmViewChecks(api, view, SF) {
  console.log('\nPayslips — view rendering & missing-table state (vm)');
  await test('missing table renders the migration filename + PostgREST error', async () => {
    api._reset();
    SF.currentProjectId = 'project-1';
    SF.db.selectStrict = async () => ({ rows: [], error: new Error('relation "public.payslips" does not exist') });
    const el = fakeEl();
    view.render(el);
    await sleep(30);
    assert(el.innerHTML.includes(MIGRATION_REL), 'migration filename missing from empty state');
    assert(el.innerHTML.includes('does not exist'), 'PostgREST error message missing');
    assert(/database update/i.test(el.innerHTML), 'migration hint headline missing');
  });
  await test('saved rows render with escaped worker names and status tags', async () => {
    api._reset();
    SF.currentProjectId = 'project-1';
    SF.db.selectStrict = async () => ({
      rows: [{
        id: 'ps-1', project_id: 'project-1', worker_id: 'w1', worker_name: '<img src=x onerror=alert(1)>', staff_no: 'EMP-1',
        period: '2026-11', days_worked: 2, reg_hours: 8, ot_hours: 2, hourly_rate_aed: 25, ot_rate_aed: 37.5,
        gross_aed: 275, loan_deduction_aed: 275, other_deductions_aed: 0, net_aed: 0, status: 'paid', notes: 'Loan shortfall: AED 4725.00 carried forward to next period.'
      }],
      error: null
    });
    const el = fakeEl();
    view.render(el);
    await sleep(30);
    assert(el.innerHTML.includes('&lt;img'), 'worker name must be HTML-escaped');
    assert(!el.innerHTML.includes('<img src=x'), 'raw markup leaked into the DOM');
    assert(el.innerHTML.includes('AED 275.00'), 'gross total rendered');
    assert(el.innerHTML.includes(MIGRATION_REL) === false, 'error card shown despite rows');
    assert(/Paid|paid/i.test(el.innerHTML), 'status rendered');
  });
  await test('module render never throws for odd state (nulls, empty rows)', async () => {
    api._reset();
    SF.currentProjectId = 'project-1';
    SF.db.selectStrict = async () => ({ rows: [null, {}], error: null });
    const el = fakeEl();
    view.render(el);
    await sleep(30);
    assert(el.innerHTML.length > 0, 'view rendered nothing');
    SF.currentProjectId = null;
    const el2 = fakeEl();
    view.render(el2);
    assert(/Select a project/i.test(el2.innerHTML), 'no-project state missing');
    SF.currentProjectId = 'project-1';
    api._reset();
  });
}

async function printChecks(api, SF) {
  console.log('\nPayslips — print document (pure)');
  await test('one payslip per page; bulk print is a single document', () => {
    const one = api.buildPrintHtml([{ worker_name: 'Alice Dsouza', staff_no: 'EMP-9001', period: '2026-11', days_worked: 2, reg_hours: 8, ot_hours: 2, hourly_rate: 25, ot_rate: 37.5, gross: 275, loan_deduction: 0, other_deductions: 0, net: 275, status: 'approved' }], { period: '2026-11' });
    assert(one.includes('page-break-after:always'), 'page-break-between-slips CSS missing');
    eq((one.match(/<!DOCTYPE html>/g) || []).length, 1, 'single document doctype');
    assert(one.includes('class="slip"'), 'slip container missing');
    const bulk = api.buildPrintHtml([
      { worker_name: 'A', period: '2026-11', net: 1 },
      { worker_name: 'B', period: '2026-11', net: 2 },
      { worker_name: 'C', period: '2026-11', net: 3 }
    ], { period: '2026-11' });
    eq((bulk.match(/class="slip"/g) || []).length, 3, 'bulk document has 3 slips');
    eq((bulk.match(/<!DOCTYPE html>/g) || []).length, 1, 'bulk is one document');
  });
  await test('print HTML escapes a worker name containing <script>', () => {
    const hostile = '<script>alert("payslip")</script><img src=x onerror=alert(1)>';
    const html = api.buildPrintHtml([{ worker_name: hostile, staff_no: 'EMP-X', period: '2026-11', reg_hours: 8, ot_hours: 2, hourly_rate: 25, ot_rate: 37.5, gross: 275, net: 275 }], { period: '2026-11' });
    assert(!html.includes('<script>alert'), 'raw <script> leaked into print HTML');
    assert(!html.includes('<img src=x'), 'raw <img onerror> leaked into print HTML');
    assert(html.includes('&lt;script&gt;alert'), 'script name was not HTML-escaped');
    assert(html.includes('&lt;img src=x'), 'img name was not HTML-escaped');
  });
  await test('print document carries branding, earnings/deductions, net and 3 signatures', () => {
    SF.company.logo_data = 'data:image/png;base64,AAAA';
    try {
      const html = api.buildPrintHtml([{
        worker_name: 'Alice Dsouza', staff_no: 'EMP-9001', nationality: 'Indian', trade: 'CONC', period: '2026-11',
        days_worked: 2, reg_hours: 8, ot_hours: 2, hourly_rate: 25, ot_rate: 37.5, gross: 275,
        loan_deduction: 100, other_deductions: 25, net: 150, status: 'approved', notes: 'Loan shortfall: AED 12.00 carried forward to next period.'
      }], { period: '2026-11' });
      assert(html.includes('Al Nakheel Contracting LLC'), 'company name missing');
      assert(html.includes('Al Quoz'), 'company address missing');
      assert(html.includes('<img src="data:image/png;base64,AAAA"'), 'company logo missing');
      assert(html.includes('EMP-9001'), 'staff no missing');
      assert(html.includes('Indian') && html.includes('CONC'), 'nationality/trade missing');
      assert(html.includes('8 h') && html.includes('2 h'), 'regular/OT hours missing');
      assert(html.includes('37.50'), 'OT rate amount missing');
      assert(html.includes('AED 275.00'), 'gross missing');
      assert(html.includes('AED 100.00') && html.includes('AED 25.00'), 'deductions missing');
      assert(html.includes('AED 150.00'), 'net missing');
      assert(html.includes('Employee') && html.includes('Prepared by') && html.includes('Approved by'), 'signature lines missing');
      assert(html.includes('Loan shortfall'), 'notes row missing');
      assert(html.includes('dir="ltr"'), 'LTR direction missing');
    } finally {
      SF.company.logo_data = null;
    }
  });
  await test('Arabic print output is RTL and localised', () => {
    SF.language = 'ar';
    try {
      const html = api.buildPrintHtml([{ worker_name: 'Alice', period: '2026-11', net: 10 }], { period: '2026-11', language: 'ar' });
      assert(html.includes('dir="rtl"'), 'RTL direction missing');
      assert(html.includes('lang="ar"'), 'Arabic lang missing');
      assert(/[\u0600-\u06FF]/.test(html), 'Arabic labels missing');
      assert(html.includes('قسيمة راتب'), 'Arabic payslip title missing');
    } finally {
      SF.language = 'en';
    }
  });
}

/* ------------------------------------------------------------------ *
 * Layer 3 — headless integration through the shared testkit          *
 * ------------------------------------------------------------------ */
function buildFixtures() {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const day = (n) => `${period}-${String(n).padStart(2, '0')}`;
  const projectA = 'c0000000-0000-4000-8000-000000000001'; // mock seed project A
  const company = 'a0000000-0000-4000-8000-000000000001';
  return {
    period,
    projectA,
    company,
    fixtureOverrides: {
      workers: [
        { id: 'e0000000-0000-4000-8000-000000000101', company_id: company, staff_no: 'EMP-9001', name: 'Alice Dsouza', role: 'Worker', trade: 'CONC', nationality: 'Indian', phone: '+971 50 000 0001', email: 'alice@example.com', status: 'active', notes: '<!--sfpay:{"salary":6500,"loan":5000,"deduct":800}-->\nSteel fixer.' },
        { id: 'e0000000-0000-4000-8000-000000000102', company_id: company, staff_no: 'EMP-9002', name: 'Bob Okoro', role: 'Worker', trade: 'STEL', nationality: 'Nigerian', phone: null, email: null, status: 'active', notes: '{"salary_aed":3000,"loan_balance":0,"loan_deduction":0}' },
        { id: 'e0000000-0000-4000-8000-000000000103', company_id: company, staff_no: 'EMP-9003', name: 'Carol Diaz', role: 'Worker', trade: 'ELEC', nationality: 'Filipino', phone: null, email: null, status: 'active', salary_aed: 4160, loan_balance: 0, notes: 'Legacy worker row with raw salary columns.' }
      ],
      timesheets: [
        { id: 'f0000000-0000-4000-8000-000000000201', project_id: projectA, employee_name: 'Alice Dsouza', trade: 'CONC', work_date: day(1), reg_hours: 4, ot_hours: 1, total_hours: 5, rate_aed: 25, total_cost_aed: 137.5, status: 'approved', approved_by: 'Hamed Al Kitbi' },
        { id: 'f0000000-0000-4000-8000-000000000202', project_id: projectA, employee_name: 'Alice Dsouza', trade: 'CONC', work_date: day(2), reg_hours: 4, ot_hours: 1, total_hours: 5, rate_aed: 25, total_cost_aed: 137.5, status: 'approved', approved_by: 'Hamed Al Kitbi' },
        { id: 'f0000000-0000-4000-8000-000000000203', project_id: projectA, employee_name: 'Bob Okoro', trade: 'STEL', work_date: day(1), reg_hours: 8, ot_hours: 0, total_hours: 8, rate_aed: 20, total_cost_aed: 160, status: 'approved', approved_by: 'Hamed Al Kitbi' },
        { id: 'f0000000-0000-4000-8000-000000000204', project_id: projectA, employee_name: 'Ghost Worker', trade: 'HEQV', work_date: day(1), reg_hours: 2, ot_hours: 0, total_hours: 2, rate_aed: 15, total_cost_aed: 30, status: 'approved', approved_by: 'Hamed Al Kitbi' },
        { id: 'f0000000-0000-4000-8000-000000000205', project_id: projectA, employee_name: 'Alice Dsouza', trade: 'CONC', work_date: day(3), reg_hours: 8, ot_hours: 0, total_hours: 8, rate_aed: 25, total_cost_aed: 200, status: 'pending', approved_by: null },
        { id: 'f0000000-0000-4000-8000-000000000206', project_id: projectA, employee_name: 'Bob Okoro', trade: 'STEL', work_date: '2026-01-15', reg_hours: 8, ot_hours: 0, total_hours: 8, rate_aed: 20, total_cost_aed: 160, status: 'approved', approved_by: 'Hamed Al Kitbi' }
      ],
      payslips: []
    }
  };
}

async function headlessChecks() {
  console.log('\nPayslips — headless integration (real app + mock Supabase)');
  let tk;
  try {
    tk = await import('../lib/testkit.mjs');
  } catch (error) {
    console.log(`  ⚠ skipped: tools/lib/testkit.mjs is not available yet (${error.message})`);
    console.log('    static + pure checks above still cover the module; rerun when the harness lands.');
    return;
  }
  const fixtures = buildFixtures();
  const { assert: tkAssert } = tk;
  const PERIOD = fixtures.period;

  try {
    await tk.withApp({ role: 'director', project: 0, fixtureOverrides: fixtures.fixtureOverrides }, async (app) => {
      const { evaluate, waitFor, diagnostics } = app;
      const jsErrors = () => diagnostics.errors.filter((line) => /^EXCEPTION|^console\.error/.test(line));
      const mainText = () => evaluate(`document.getElementById('main').textContent`);

      await test('headless: payslips view renders for director with no JS exceptions', async () => {
        const viewId = await app.goView('payslips');
        tkAssert(viewId === 'payslips', `expected view "payslips", got ${JSON.stringify(viewId)}`);
        await waitFor(`/Saved payslips/.test(document.getElementById('main').textContent)`, { label: 'payslips view body' });
        const text = await mainText();
        tkAssert(text.includes('Generate from timesheets'), 'generate button missing');
        tkAssert(text.includes('No payslips saved for this period yet'), 'empty state missing');
        tkAssert(jsErrors().length === 0, jsErrors().join(' | '));
      });

      await test('headless: default period is the current YYYY-MM', async () => {
        const period = await evaluate(`window.SF_modules.payslips._state.period`);
        eq(period, PERIOD, 'module default period');
        const inputValue = await evaluate(`document.getElementById('psPeriod').value`);
        eq(inputValue, PERIOD, 'period input value');
      });

      await test('headless: generate previews the approved timesheets (OT ×1.5, 8h@25+2hOT=275)', async () => {
        await evaluate(`window.SF_modules.payslips._generate();true`);
        await waitFor(`(function(){var s=window.SF_modules.payslips._state;return !!(s.preview && s.preview.length === 3);})()`, { label: 'preview lines' });
        const preview = await evaluate(`(function(){
          return window.SF_modules.payslips._state.preview.map(function(l){
            return {worker_name:l.worker_name, matched:l.matched, reg_hours:l.reg_hours, ot_hours:l.ot_hours, hourly_rate:l.hourly_rate, ot_rate:l.ot_rate, gross:l.gross, loan_deduction:l.loan_deduction, net:l.net, shortfall:l.shortfall, days_worked:l.days_worked, warnings:l.warnings};
          });
        })()`);
        eq(preview.length, 3, 'preview line count');
        const alice = preview.find((line) => line.worker_name === 'Alice Dsouza');
        const bob = preview.find((line) => line.worker_name === 'Bob Okoro');
        const ghost = preview.find((line) => line.worker_name === 'Ghost Worker');
        tkAssert(alice && bob && ghost, 'expected Alice/Bob/Ghost preview lines');
        eq(alice.reg_hours, 8, 'Alice reg hours');
        eq(alice.ot_hours, 2, 'Alice OT hours');
        eq(alice.ot_rate, 37.5, 'Alice OT rate = 25 × 1.5');
        eq(alice.gross, 275, 'Alice gross = 8×25 + 2×37.5');
        eq(alice.days_worked, 2, 'Alice days worked');
        eq(alice.loan_deduction, 275, 'Alice loan capped at gross');
        eq(alice.net, 0, 'Alice net floored at 0');
        eq(alice.shortfall, 4725, 'Alice shortfall = 5000 - 275');
        eq(bob.hourly_rate, 20, 'Bob rate from timesheets');
        eq(bob.gross, 160, 'Bob gross');
        eq(bob.net, 160, 'Bob net');
        eq(ghost.matched, false, 'unmatched name flagged in preview');
        tkAssert(ghost.warnings.some((w) => /matching worker/i.test(w)), 'unmatched warning missing');
        const grossCell = await evaluate(`document.getElementById('ps-gross-0').textContent`);
        eq(grossCell, 'AED 275.00', 'preview gross cell');
        const warnBadge = await evaluate(`document.getElementById('ps-warn-2').textContent`);
        tkAssert(/matching worker/i.test(warnBadge), 'warning badge missing for unmatched name');
      });

      await test('headless: batch save is idempotent (same period twice = same rows)', async () => {
        const saved = await evaluate(`(async function(){
          var api = window.SF_modules.payslips;
          var period = api._state.period;
          var pid = window.SF.currentProjectId;
          var lines = api._state.preview;
          var first = await api.saveBatch(period, lines, pid);
          var rows1 = (window.__MOCK_DB.payslips || []).slice();
          var second = await api.saveBatch(period, lines, pid);
          var rows2 = (window.__MOCK_DB.payslips || []).slice();
          return { saved: first.saved, secondSaved: second.saved, count1: rows1.length, count2: rows2.length, rows: rows2 };
        })()`);
        eq(saved.saved, 3, 'first save count');
        eq(saved.secondSaved, 3, 'second save count');
        eq(saved.count1, 3, 'rows after first save');
        eq(saved.count2, 3, 'rows after second save (idempotent upsert)');
        const alice = saved.rows.find((row) => row.worker_name === 'Alice Dsouza');
        const ghost = saved.rows.find((row) => row.worker_name === 'Ghost Worker');
        tkAssert(alice, 'Alice payslip not persisted');
        tkAssert(ghost, 'Ghost payslip not persisted');
        eq(alice.worker_id, 'e0000000-0000-4000-8000-000000000101', 'Alice worker_id persisted');
        eq(alice.gross_aed, 275, 'Alice gross_aed');
        eq(alice.loan_deduction_aed, 275, 'Alice loan_deduction_aed');
        eq(alice.net_aed, 0, 'Alice net_aed');
        tkAssert(/Loan shortfall: AED 4,725\.00/.test(alice.notes), 'shortfall not recorded in notes: ' + alice.notes);
        tkAssert(/carried forward/i.test(alice.notes), 'shortfall carry-forward wording missing');
        eq(ghost.worker_id, null, 'unmatched payslip saved with worker_id null');
      });

      await test('headless: UI save path clears preview and reloads the saved list', async () => {
        await evaluate(`window.SF_modules.payslips._generate();window.SF_modules.payslips._save();true`);
        await waitFor(`(function(){var s=window.SF_modules.payslips._state;return !s.preview && s.loaded && !s.loading;})()`, { label: 'save + reload' });
        await waitFor(`/Saved payslips · 3/.test(document.getElementById('main').textContent)`, { label: 'saved list count' });
        const count = await evaluate(`(window.__MOCK_DB.payslips || []).length`);
        eq(count, 3, 'UI save must not duplicate rows');
        const text = await mainText();
        tkAssert(text.includes('Alice Dsouza'), 'saved Alice row missing');
        tkAssert(/no worker/i.test(text), 'unmatched saved row should carry a warning badge');
      });

      await test('headless: status flow draft → approved → paid with paid_at, preserved by re-save', async () => {
        const id = await evaluate(`(function(){
          var rows = window.__MOCK_DB.payslips || [];
          for (var i = 0; i < rows.length; i += 1) if (rows[i].worker_name === 'Alice Dsouza') return rows[i].id;
          return null;
        })()`);
        tkAssert(id, 'Alice payslip id not found');
        await evaluate(`window.SF_modules.payslips._action(${JSON.stringify(id)}, 'approve'); true`);
        await waitFor(`window.__MOCK_DB.payslips.some(function(r){return r.id === ${JSON.stringify(id)} && r.status === 'approved';})`, { label: 'approved status' });
        await evaluate(`window.SF_modules.payslips._action(${JSON.stringify(id)}, 'paid'); true`);
        await waitFor(`window.__MOCK_DB.payslips.some(function(r){return r.id === ${JSON.stringify(id)} && r.status === 'paid' && !!r.paid_at;})`, { label: 'paid status + paid_at' });
        const afterResave = await evaluate(`(async function(){
          var api = window.SF_modules.payslips;
          var lines = api.buildLines({ period: api._state.period });
          await api.saveBatch(api._state.period, lines, window.SF.currentProjectId);
          var rows = window.__MOCK_DB.payslips || [];
          var row = null;
          for (var i = 0; i < rows.length; i += 1) if (rows[i].id === ${JSON.stringify(id)}) row = rows[i];
          return { count: rows.length, status: row && row.status, paid_at: row && row.paid_at };
        })()`);
        eq(afterResave.count, 3, 're-save must not duplicate rows');
        eq(afterResave.status, 'paid', 'upsert must not reset a paid payslip to draft');
        tkAssert(!!afterResave.paid_at, 'paid_at must survive a re-save');
      });

      await test('headless: print HTML is one page per slip and escapes hostile names', async () => {
        const print = await evaluate(`(function(){
          var api = window.SF_modules.payslips;
          var hostile = '<script>alert(1)</script>';
          var single = api.buildPrintHtml([{worker_name: hostile, staff_no: 'EMP-<b>1</b>', period: ${JSON.stringify(PERIOD)}, days_worked: 2, reg_hours: 8, ot_hours: 2, hourly_rate: 25, ot_rate: 37.5, gross: 275, loan_deduction: 0, other_deductions: 0, net: 275, status: 'approved'}], {period: ${JSON.stringify(PERIOD)}});
          var bulk = api.buildPrintHtml([
            {worker_name: 'Alice Dsouza', period: ${JSON.stringify(PERIOD)}, net: 1},
            {worker_name: 'Bob Okoro', period: ${JSON.stringify(PERIOD)}, net: 2}
          ], {period: ${JSON.stringify(PERIOD)}});
          return {single: single, bulk: bulk};
        })()`);
        tkAssert(!print.single.includes('<script>alert(1)</script>'), 'raw <script> leaked into print HTML');
        tkAssert(print.single.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'hostile worker name not escaped');
        tkAssert(print.single.includes('page-break-after:always'), 'one-payslip-per-page CSS missing');
        tkAssert(print.single.includes('Al Nakheel Contracting LLC'), 'company branding missing from print doc');
        tkAssert(print.single.includes('Employee') && print.single.includes('Prepared by') && print.single.includes('Approved by'), 'signature lines missing');
        eq((print.bulk.match(/class="slip"/g) || []).length, 2, 'bulk print contains both slips in one document');
        eq((print.bulk.match(/<!DOCTYPE html>/g) || []).length, 1, 'bulk print is a single document');
      });

      await test('headless: editing a negative hour in the preview clamps to 0 and warns', async () => {
        await evaluate(`window.SF_modules.payslips._generate();true`);
        await waitFor(`(function(){var s=window.SF_modules.payslips._state;return !!(s.preview && s.preview.length === 3 && document.getElementById('ps-gross-0'));})()`, { label: 'preview DOM' });
        const edited = await evaluate(`(function(){
          var input = document.querySelectorAll('input[aria-label="Reg hours"]')[0];
          input.value = '-8';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          var line = window.SF_modules.payslips._state.preview[0];
          return {
            inputValue: input.value,
            regHours: line.reg_hours,
            gross: line.gross,
            net: line.net,
            warning: (document.getElementById('ps-warn-0') || {}).textContent || '',
            grossCell: (document.getElementById('ps-gross-0') || {}).textContent || '',
            totalNet: (document.getElementById('ps-tot-net') || {}).textContent || ''
          };
        })()`);
        eq(edited.inputValue, '0', 'negative input reset to 0 in the field');
        eq(edited.regHours, 0, 'line regular hours clamped');
        eq(edited.gross, 75, 'recomputed gross keeps the 2h OT (2 × 37.50)');
        eq(edited.net, 0, 'loan takes the remaining 75, net stays 0');
        tkAssert(/clamped/i.test(edited.warning), 'warning badge missing after clamping: ' + edited.warning);
        eq(edited.grossCell, 'AED 75.00', 'gross cell refreshed');
        eq(edited.totalNet, 'AED 190.00', 'totals row refreshed (Bob 160 + Ghost 30)');
      });

      await test('headless: no JS exceptions across the full payslips workflow', async () => {
        tkAssert(jsErrors().length === 0, jsErrors().join(' | '));
      });
    });
  } catch (error) {
    record('headless harness runs the payslips workflow', false, error && error.message ? error.message : String(error));
    return;
  }

  // Manager-only gate: a lead must not be able to open the module view.
  try {
    await tk.withApp({ role: 'lead', project: 0 }, async (app) => {
      await test('headless: leads cannot open the manager-only payslips view', async () => {
        const viewId = await app.goView('payslips');
        tkAssert(viewId !== 'payslips', `lead opened a manager-only view (${viewId})`);
      });
    });
  } catch (error) {
    record('headless: lead role gate', false, error && error.message ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ *
 * Runner                                                             *
 * ------------------------------------------------------------------ */
async function main() {
  console.log('\nPayslips module checks');
  const { api, view, SF, source } = await loadModuleInVm();
  await staticChecks();
  // staticChecks imports cdp for node --check; source is also parse-checked by vm.
  eq(typeof source, 'string', 'module source loaded');

  await pureChecks(api);
  await vmViewChecks(api, view, SF);
  await printChecks(api, SF);
  await headlessChecks();

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} failed` : ''}\n`);
  if (failed) {
    console.log('Failures:');
    for (const failure of results.filter((result) => !result.ok)) console.log(`  - ${failure.name}: ${failure.detail}`);
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error('\nPayslips check harness failure:', error);
  process.exit(1);
});
