// Financial Accounts module checks — dependency-free Node script.
//
//   node tools/checks/finance.mjs
//
// Three layers:
//   1. Static checks   — files exist, JS parses, SQL is idempotent/non-destructive,
//                        view registration + required export surface, CSV safety.
//   2. Pure unit checks — the module is loaded into a `node:vm` sandbox with a stub
//                        window.SF and the exported deterministic statement maths
//                        are called with hand-computed fixture rows (AR/AP totals,
//                        balance-sheet identity, ageing boundaries, P&L excl. VAT,
//                        missing optional tables, CSV formula injection, print doc).
//   3. Browser checks  — when the shared harness tools/lib/testkit.mjs exists, log in
//                        as a director, go to the finance view and assert it renders
//                        with fixtures, that the balance-sheet identity holds in the
//                        DOM, tab switching works and there are zero JS exceptions.
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = join(ROOT, 'scripts/modules/finance-statements.js');
const MIGRATION = join(ROOT, 'supabase/migrations/202611031002_finance_statements.sql');
const DOCS = join(ROOT, 'docs/modules/finance.md');
const TESTKIT = join(ROOT, 'tools/lib/testkit.mjs');

const results = [];
let currentSection = 'general';
function section(name) { currentSection = name; console.log('\n' + name); }
function record(name, ok, detail = '') {
  results.push({ section: currentSection, name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? '\n      ' + String(detail).replace(/\n/g, '\n      ') : ''}`);
}
async function test(name, fn) {
  try { await fn(); record(name, true); }
  catch (error) { record(name, false, error && error.message ? error.message : error); }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function near(actual, expected, label, eps = 0.001) {
  if (Math.abs(Number(actual) - Number(expected)) > eps) {
    throw new Error(`${label}: expected ${expected} ± ${eps}, got ${actual}`);
  }
}

/* ------------------------------------------------------------------ fixtures */
const TODAY = '2026-03-05';

const FIXTURE = {
  projects: [
    { id: 'p1', code: 'P-001', name: 'Warehouse A', contract_value_aed: 500000 },
    { id: 'p2', code: 'P-002', name: 'Villa B', contract_value_aed: 300000 }
  ],
  companies: [{ id: 'co1', name: 'Forgesite Contracting LLC', address: 'Dubai, UAE', tax_id: '100123456700003' }],
  billings: [
    { id: 'b1', billing_no: 'PB-001', status: 'certified', total_claim: 10000, net_payable: 9000, retention_amount: 1000, vat_amount: 450, current_net_excl_vat: 9000, vat_pct: 5, period_to: '2026-01-05', project_id: 'p1' },
    { id: 'b2', billing_no: 'PB-002', status: 'certified', total_claim: 5000, net_payable: 4500, retention_amount: 500, vat_amount: 225, current_net_excl_vat: 4500, vat_pct: 5, period_to: '2026-02-20', project_id: 'p2' },
    { id: 'b3', billing_no: 'PB-003', status: 'draft', total_claim: 99999, net_payable: 89999, retention_amount: 9999, vat_amount: 4999, period_to: '2026-03-01', project_id: 'p1' }
  ],
  payments: [
    { id: 'r1', payment_type: 'received', amount: 4000, status: 'paid', project_id: 'p1' },
    { id: 'p2', payment_type: 'invoice', amount: 2000, status: 'paid', due_date: '2026-04-10', invoice_no: 'SUP-1' },
    { id: 'p3', payment_type: 'pending', amount: 3000, status: 'pending', due_date: '2026-02-01', invoice_no: 'SUP-2' },
    { id: 'p4', payment_type: 'invoice', amount: 1000, status: 'cancelled', due_date: '2026-01-01' }
  ],
  materials: [
    { id: 'm1', quantity: 10, unit_cost_aed: 100, status: 'approved', invoice_date: '2026-01-01', project_id: 'p1' },
    { id: 'm2', quantity: 5, unit_cost_aed: 100, status: 'pending', invoice_date: '2026-01-01' },
    { id: 'm3', quantity: 2, unit_cost_aed: 30.5, status: 'approved', invoice_date: '2026-02-01', project_id: 'p2' }
  ],
  timesheets: [
    { id: 't1', total_cost_aed: 2500, status: 'approved', work_date: '2026-01-10', project_id: 'p1' },
    { id: 't2', total_cost_aed: 999, status: 'pending', work_date: '2026-01-11', project_id: 'p1' }
  ],
  company_expenses: [
    { id: 'e1', amount: 1500, status: 'approved', expense_date: '2026-01-15', category: 'Rent' },
    { id: 'e2', amount: 500, status: 'rejected', expense_date: '2026-01-16' }
  ],
  company_budget_lines: [{ id: 'bl1', category: 'Rent', description: 'Office rent', budget_aed: 2000, actual_aed: 1500 }],
  project_parties: [{ id: 'pt1', party_type: 'subcontractor', name: 'ACME Subco', project_id: 'p1' }],
  payment_requests: [
    { id: 'pr1', reference: 'PR-001', amount_aed: 5000, retention_pct: 10, retention_aed: 500, net_aed: 4500, status: 'approved', due_date: '2026-02-10', party_id: 'pt1', project_id: 'p1' },
    { id: 'pr2', reference: 'PR-002', amount_aed: 1000, retention_aed: 100, net_aed: 900, status: 'paid', due_date: '2026-02-10', project_id: 'p1' },
    { id: 'pr3', reference: 'PR-003', amount_aed: 700, retention_aed: 0, net_aed: 700, status: 'rejected', due_date: '2026-02-10' }
  ],
  settings: { id: 's1', company_id: 'co1', fiscal_year: 2026, opening_cash_aed: 20000, opening_equity_aed: 20000 }
};

/* ------------------------------------------------------- module in a sandbox */
function localEsc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function loadModule(sourceCode) {
  const views = {};
  const helpers = {
    esc: localEsc,
    money: (n) => (Number(n) < 0 ? '-AED ' : 'AED ') + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    money0: (n) => (Number(n) < 0 ? '-AED ' : 'AED ') + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US'),
    num: (n, d) => Number(n || 0).toFixed(d != null ? d : 2),
    numOr: (v, f) => (v === null || v === undefined || v === '' ? f : Number(v)),
    fmtDate: (v) => String(v || '—'),
    fmtTime: () => '—',
    today: () => TODAY,
    toLocalDate: () => null,
    daysUntil: () => null,
    safeImgSrc: (src) => {
      if (!src || typeof src !== 'string') return '';
      const s = src.trim();
      if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return s;
      if (/^https:\/\/[a-z0-9.-]+\.supabase\.co\//i.test(s)) return s;
      return '';
    },
    genUUID: () => 'uuid',
    parsePhotos: () => []
  };
  const stubTable = { select() { return this; }, eq() { return this; }, order() { return this; }, range() { return Promise.resolve({ data: [], error: null }); } };
  const SF = {
    helpers,
    db: {
      select: async () => [],
      selectStrict: async () => ({ rows: [], error: null }),
      insert: async () => ({}),
      update: async () => ({}),
      remove: async () => ({}),
      log: async () => ({}),
      client: () => ({ from: () => stubTable }),
      isReady: () => true
    },
    ui: {
      toast() {}, openModal() {}, closeModal() {}, openFormModal() {},
      render() {}, goView() {}, canManage: () => true, hasView: () => true
    },
    data: { state: { projects: [], expenses: [], companyBudget: [], workers: [] } },
    registerView(def) { views[def.id] = def; },
    navItems: () => [],
    hasViewDefined: (id) => !!views[id],
    language: 'en',
    company: { id: 'co1', name: 'Forgesite Contracting LLC' },
    user: { id: 'u1', name: 'Director', role: 'director' },
    currentProject: null,
    currentProjectId: null,
    parties: []
  };
  const sandbox = {
    window: { SF, SFviews: views, SF_modules: undefined },
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {}, click() {} }),
      body: { appendChild() {}, removeChild() {} },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    Blob: class BlobStub { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    setTimeout, clearTimeout, console, Date, Math, JSON, RegExp, Promise,
    Number, String, Boolean, Object, Array, Error, isFinite, isNaN
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  new vm.Script(sourceCode, { filename: 'scripts/modules/finance-statements.js' }).runInContext(sandbox);
  return { api: sandbox.window.SF_modules && sandbox.window.SF_modules.finance, views, window: sandbox.window };
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/* ========================================================================== */
async function main() {
  console.log('Financial Accounts module — checks\n');

  const moduleSource = await readFile(MODULE, 'utf8');

  /* ---------------------------------------------------------------- static */
  section('Static checks');
  await test('module file exists', async () => {
    const info = await stat(MODULE);
    assert(info.size > 4000, `module suspiciously small (${info.size} bytes)`);
  });
  await test('module parses as a classic script', () => {
    new vm.Script(moduleSource, { filename: MODULE });
  });
  await test('module is a self-contained IIFE guarding missing SF', () => {
    assert(/\(function\s*\(\)\s*\{/.test(moduleSource), 'missing IIFE');
    assert(/if\s*\(!window\.SF\)\s*return;/.test(moduleSource), 'missing window.SF guard');
  });
  await test('registers the company-scoped finance view for director/controller', () => {
    assert(/id:\s*'finance'/.test(moduleSource), 'view id finance missing');
    assert(/section:\s*'company'/.test(moduleSource), 'nav section must be company');
    assert(/roles:\s*\[\s*'director'\s*,\s*'controller'\s*\]/.test(moduleSource), 'roles must be director/controller');
    assert(/labelAr:/.test(moduleSource), 'missing Arabic nav label');
  });
  await test('exposes the required pure API on window.SF_modules.finance', () => {
    assert(/window\.SF_modules\.finance\s*=/.test(moduleSource), 'window.SF_modules.finance missing');
    for (const key of ['ageing', 'arTotal', 'apTotal', 'balanceSheet', 'pnl']) {
      assert(new RegExp(`\\b${key}\\s*:`).test(moduleSource), `API key missing: ${key}`);
    }
  });
  await test('fetches tables without a project filter via selectStrict', () => {
    assert(/DB\.selectStrict\(name,\s*null,\s*null/.test(moduleSource), 'selectStrict must be called with null filters');
    for (const table of ['payments', 'progress_billings', 'materials', 'timesheets', 'company_expenses', 'company_budget_lines', 'project_parties', 'projects', 'companies']) {
      assert(moduleSource.includes(`'${table}'`), `table not fetched: ${table}`);
    }
    assert(moduleSource.includes("'payment_requests'"), 'optional payment_requests not fetched');
    assert(moduleSource.includes("'finance_settings'"), 'finance_settings not fetched');
  });
  await test('uses app money helpers, not raw float prints', () => {
    assert(/H\.money\b/.test(moduleSource) && /H\.money0\b/.test(moduleSource), 'must use SF.helpers.money / money0');
    assert(!/'AED '\s*\+\s*\(?Number\(/.test(moduleSource), 'raw AED float concatenation found');
    assert(/function round2\(/.test(moduleSource), 'missing round2');
  });
  await test('CSV export prefixes formula-leading cells and adds a UTF-8 BOM', () => {
    assert(/\^\[=\+\\-@\\t\\r\]/.test(moduleSource), 'formula-injection prefix regex missing');
    assert(moduleSource.includes("'\\uFEFF'"), 'UTF-8 BOM missing');
    assert(/new Blob\(/.test(moduleSource), 'Blob download missing');
    assert(/\.click\(\)/.test(moduleSource), 'anchor click download missing');
  });
  await test('print/PDF document is dir-aware and builder is exposed', () => {
    assert(/dir="'\s*\+\s*\(isAr\s*\?\s*'rtl'\s*:\s*'ltr'\)/.test(moduleSource), 'print doc dir attribute missing');
    assert(/printHTML\s*:/.test(moduleSource), 'printHTML not exposed');
    assert(/safeImg\(/.test(moduleSource), 'company logo must go through safeImgSrc');
  });
  await test('balance-sheet identity is checked with a 0.01 tolerance', () => {
    assert(/balanced:\s*Math\.abs\(diff\)\s*<=\s*0\.01/.test(moduleSource), 'balanced tolerance missing');
  });
  await test('manager-only writes are guarded by SF.ui.canManage()', () => {
    assert(/UI\.canManage\(\)/.test(moduleSource), 'canManage guard missing');
    assert(/UI\.openFormModal\(/.test(moduleSource), 'settings edit must use the shared form modal');
  });

  section('Migration');
  await test('migration file exists with the agreed name', async () => {
    const info = await stat(MIGRATION);
    assert(info.size > 1000, 'migration suspiciously small');
  });
  const migration = await readFile(MIGRATION, 'utf8');
  const migrationCode = stripSqlComments(migration);
  await test('creates finance_settings idempotently', () => {
    assert(/create table if not exists public\.finance_settings/i.test(migrationCode), 'missing create table if not exists');
    assert(/id\s+uuid primary key default gen_random_uuid\(\)/i.test(migrationCode), 'uuid pk missing');
    assert(/company_id\s+uuid/i.test(migrationCode), 'company_id missing');
    assert(/fiscal_year\s+integer/i.test(migrationCode), 'fiscal_year missing');
    assert(/opening_cash_aed\s+numeric\(14,2\)[^,]*default 0/i.test(migrationCode), 'opening_cash_aed default 0 missing');
    assert(/opening_equity_aed\s+numeric\(14,2\)[^,]*default 0/i.test(migrationCode), 'opening_equity_aed default 0 missing');
    assert(/created_at\s+timestamptz/i.test(migrationCode), 'created_at missing');
    assert(/create index if not exists finance_settings/i.test(migrationCode), 'index not idempotent');
    assert(/unique \(company_id, fiscal_year\)/i.test(migrationCode), 'unique(company_id, fiscal_year) missing');
  });
  await test('enables RLS with explicit policies and the shared role helper', () => {
    assert(/alter table public\.finance_settings enable row level security/i.test(migrationCode), 'RLS not enabled');
    for (const policy of ['select', 'insert', 'update', 'delete']) {
      assert(new RegExp(`policy finance_settings_${policy}\\b`, 'i').test(migrationCode), `policy finance_settings_${policy} missing`);
    }
    assert(/create or replace function public\.sf_current_role\(\)/.test(migrationCode), 'sf_current_role helper missing');
    assert((migrationCode.match(/sf_current_role\(\) in \('director','controller'\)/g) || []).length >= 3, 'manager role checks missing');
  });
  await test('migration is non-destructive outside its rollback notes', () => {
    assert(!/\bdrop\s+table\b/i.test(migrationCode), 'drop table in executable SQL');
    assert(!/\bdrop\s+column\b/i.test(migrationCode), 'drop column in executable SQL');
    assert(!/\btruncate\b/i.test(migrationCode), 'truncate in executable SQL');
    assert(!/\bdelete\s+from\b/i.test(migrationCode), 'delete from in executable SQL');
    assert(!/\balter\s+table\s+public\.(projects|profiles|payments)/i.test(migrationCode), 'must not alter existing core tables');
  });

  /* ------------------------------------------------------------------ unit */
  section('Pure statement maths (node:vm with SF stub)');
  const { api, views } = loadModule(moduleSource);
  await test('view registered in the sandbox', () => {
    assert(views.finance, 'finance view not registered');
    eq(views.finance.nav.section, 'company', 'nav section');
  });
  await test('AR = certified net payable − received payments', () => {
    const r = api.arTotal(FIXTURE);
    near(r.certifiedNet, 13500, 'certified net');
    near(r.received, 4000, 'received');
    near(r.ar, 9500, 'AR');
    eq(r.count, 2, 'certified certificate count (draft excluded)');
  });
  await test('AP = approved payment requests + material AP + unpaid supplier invoices', () => {
    const r = api.apTotal(FIXTURE);
    near(r.paymentRequests, 4500, 'approved payment requests');
    near(r.materials, 0, 'material AP after paid supplier invoice offset');
    near(r.payments, 3000, 'pending supplier invoice');
    near(r.ap, 7500, 'AP');
    eq(r.requestCount, 1, 'only approved/unpaid request counted');
  });
  await test('ageing buckets: current, 1-30, 31-60, 61-90, 90+', () => {
    const rows = [
      { due_date: '2026-03-06', amount: 1 },     // not due
      { due_date: '2026-03-05', amount: 2 },     // due today = current
      { due_date: '2026-03-04', amount: 4 },     // 1
      { due_date: '2026-02-03', amount: 8 },     // 30
      { due_date: '2026-02-02', amount: 16 },    // 31
      { due_date: '2026-01-04', amount: 32 },    // 60
      { due_date: '2026-01-03', amount: 64 },    // 61
      { due_date: '2025-12-05', amount: 128 },   // 90
      { due_date: '2025-12-04', amount: 256 }    // 91
    ];
    const a = api.ageing(rows, { today: TODAY });
    near(a.current, 3, 'current (not yet due + due today)');
    near(a.d1_30, 12, '1-30 boundary: 1 and 30 inclusive');
    near(a.d31_60, 48, '31-60 boundary: 31 and 60 inclusive');
    near(a.d61_90, 192, '61-90 boundary: 61 and 90 inclusive');
    near(a.d90plus, 256, '90+ boundary: 91 days');
    near(a.total, 1 + 2 + 4 + 8 + 16 + 32 + 64 + 128 + 256, 'ageing total');
    eq(a.buckets.find((b) => b.key === 'current').count, 2, 'current item count');
    eq(a.buckets.find((b) => b.key === 'd1_30').count, 2, '1-30 item count');
  });
  await test('ageing falls back to invoice date when due_date is null', () => {
    const a = api.ageing([{ due_date: null, invoice_date: '2026-01-04', amount: 100 }], { today: TODAY });
    near(a.d31_60, 100, 'invoice-date fallback at 60 days');
    near(a.total, 100, 'total');
  });
  await test('ageing treats a missing date as current (documented conservative rule)', () => {
    const a = api.ageing([{ amount: 50 }], { today: TODAY });
    near(a.current, 50, 'undated row lands in current');
  });
  await test('AR ageing FIFO allocation keeps the ageing total equal to AR', () => {
    const a = api.arAgeing(FIXTURE, { today: TODAY });
    near(a.total, api.arTotal(FIXTURE).ar, 'ageing total == AR');
    eq(a.rows.length, 2, 'two certified invoices aged');
    near(a.rows[0].applied, 4000, 'oldest invoice receives the 4,000 receipt');
    near(a.rows[0].amount, 5000, 'oldest invoice residual');
    near(a.rows[0].due, '2026-01-05', 'oldest due date first');
    near(a.d31_60, 5000, 'oldest residual is 31-60 days');
    near(a.d1_30, 4500, 'newer invoice is 1-30 days');
  });
  await test('AP ageing covers payment requests, materials and supplier invoices', () => {
    const a = api.apAgeing(FIXTURE, { today: TODAY });
    near(a.total, api.apTotal(FIXTURE).ap, 'ageing total == AP');
    const types = a.rows.map((r) => r.type).sort();
    eq(types.join(','), 'payment,payment_request', 'expected a payment request + pending supplier invoice row');
  });
  await test('balance sheet identity: assets − liabilities − equity === 0 (±0.01)', () => {
    const bs = api.balanceSheet(FIXTURE, { today: TODAY });
    near(bs.assets, 29100, 'assets (20,000 opening cash − 400 movement + 9,500 AR)');
    near(bs.liabilities, 9675, 'liabilities (7,500 AP + 1,500 retention + 675 VAT)');
    near(bs.equity, 19425, 'equity = assets − liabilities');
    near(bs.currentResult, -575, 'current-period result = equity − opening equity');
    near(bs.diff, 0, 'identity difference');
    eq(bs.balanced, true, 'balanced flag');
    near(Math.abs(bs.assets - bs.liabilities - bs.equity), 0, 'explicit identity check', 0.01);
  });
  await test('balance sheet stays balanced with awkward cents and no settings table', () => {
    const awkward = {
      billings: [
        { id: 'x1', status: 'certified', total_claim: 100.005, net_payable: 90.005, retention_amount: 10.005, vat_amount: 4.5 },
        { id: 'x2', status: 'certified', total_claim: 0.335, net_payable: 0.335, retention_amount: 0, vat_amount: 0.02 }
      ],
      payments: [
        { id: 'y1', payment_type: 'received', amount: 33.335, status: 'paid' },
        { id: 'y2', payment_type: 'invoice', amount: 0.005, status: 'paid' }
      ],
      materials: [{ id: 'z1', quantity: 3, unit_cost_aed: 33.335, status: 'approved' }],
      settings: null
    };
    const bs = api.balanceSheet(awkward, { today: TODAY });
    near(bs.diff, 0, 'identity diff');
    eq(bs.balanced, true, 'balanced with no finance_settings row');
    near(bs.openingCash, 0, 'opening cash defaults to 0');
    near(bs.openingEquity, 0, 'opening equity defaults to 0');
  });
  await test('P&L revenue excludes VAT and costs split direct vs overhead', () => {
    const p = api.pnl(FIXTURE, { today: TODAY });
    near(p.revenue, 15000, 'revenue = sum(total_claim) of certified certificates, VAT excluded');
    near(p.vatOnRevenue, 675, 'VAT reported separately');
    near(p.materials, 1000 + 61, 'approved materials only (10×100 + 2×30.5)');
    near(p.labour, 2500, 'approved timesheets only');
    near(p.expenses, 1500, 'rejected expense excluded');
    near(p.directCost, 3561, 'direct cost');
    near(p.grossProfit, 11439, 'gross profit');
    near(p.netProfit, 9939, 'net profit');
    near(p.grossMargin, 76.26, 'gross margin %');
    near(p.netMargin, 66.26, 'net margin %');
    eq(p.vatExcluded, true, 'VAT-excluded flag');
  });
  await test('project profitability splits revenue and cost per project', () => {
    const p = api.pnl(FIXTURE, { today: TODAY });
    eq(p.projects.length, 2, 'two projects with activity');
    const p1 = p.projects.find((x) => x.projectId === 'p1');
    near(p1.revenue, 10000, 'p1 revenue');
    near(p1.materials, 1000, 'p1 materials');
    near(p1.labour, 2500, 'p1 labour');
    near(p1.profit, 6500, 'p1 profit');
    const p2 = p.projects.find((x) => x.projectId === 'p2');
    near(p2.revenue, 5000, 'p2 revenue');
    near(p2.profit, 4939, 'p2 profit (5,000 − 61 materials)');
  });
  await test('optional tables absent: no crash, empty arrays tolerated', () => {
    const empty = api.compute({}, { today: TODAY });
    near(empty.ar.ar, 0, 'empty AR');
    near(empty.ap.ap, 0, 'empty AP');
    near(empty.bs.diff, 0, 'empty sheet balances');
    eq(empty.bs.balanced, true, 'empty sheet balanced');
    const noPr = Object.assign({}, FIXTURE);
    delete noPr.payment_requests;
    near(api.apTotal(noPr).ap, api.apTotal(FIXTURE).ap - 4500, 'payment_requests absent treated as empty');
  });
  await test('nullsafe mapping: weird values never throw', () => {
    const messy = {
      billings: [{ status: 'certified', net_payable: '1000.005', total_claim: null }, null],
      payments: [{ payment_type: 'received', amount: 'oops', status: 'paid' }, { payment_type: 'invoice', amount: undefined }],
      materials: [{ quantity: '2', unit_cost_aed: '3.335' }, {}],
      timesheets: [{}], company_expenses: [{}], payment_requests: [{}]
    };
    const bs = api.balanceSheet(messy, { today: TODAY });
    eq(bs.balanced, true, 'messy rows still balance');
    near(bs.ar, 1000.01, 'string number parsed (rounded)');
  });
  await test('CSV cell escaping blocks formula injection and keeps numbers numeric', () => {
    eq(api.csvCell('=1+1'), "'=1+1", 'equals');
    eq(api.csvCell('+A1'), "'+A1", 'plus');
    eq(api.csvCell('-2+3'), "'-2+3", 'minus');
    eq(api.csvCell('@SUM(A1)'), "'@SUM(A1)", 'at');
    eq(api.csvCell('normal text'), 'normal text', 'plain text unchanged');
    eq(api.csvCell(42), 42, 'numbers stay numeric');
    eq(api.csvCell(null), '', 'null -> empty');
    const csv = api.buildCSV([['=cmd', 'a,b', 'say "hi"'], [42, 'PB-001', '']]);
    assert(csv.includes("'=cmd"), 'formula cell prefixed in built CSV');
    assert(csv.includes('"a,b"'), 'comma cell quoted');
    assert(csv.includes('"say ""hi"""'), 'quote cell escaped');
  });
  await test('print pack is branded, dir-aware (AR) and escapes hostile company data', () => {
    const html = api.printHTML('all', FIXTURE, {
      lang: 'ar',
      today: TODAY,
      company: { name: 'شركة <script>alert(1)</script>', address: 'Dubai', tax_id: '123', logo_data: 'javascript:alert(1)' }
    });
    assert(html.includes('dir="rtl"'), 'Arabic print pack must be rtl');
    assert(html.includes('lang="ar"'), 'Arabic print pack must declare lang');
    assert(html.includes('شركة'), 'company name included');
    assert(!html.includes('<script>alert(1)</script>'), 'company name must be escaped');
    assert(html.includes('&lt;script&gt;'), 'escaped company name expected');
    assert(!html.includes('javascript:'), 'unsafe logo URL must be dropped');
    assert(html.includes('الميزانية العمومية'), 'Arabic balance-sheet section missing');
    assert(html.includes('AED 29,100.00'), 'assets rendered with money helper');
    const en = api.printHTML('bs', FIXTURE, { lang: 'en', today: TODAY, company: FIXTURE.companies[0] });
    assert(en.includes('dir="ltr"'), 'English print pack must be ltr');
    assert(en.includes('Balance Sheet'), 'English balance sheet section missing');
  });

  /* -------------------------------------------------------------- browser */
  section('Browser checks (tools/lib/testkit.mjs)');
  if (!existsSync(TESTKIT)) {
    record('testkit available', false, 'tools/lib/testkit.mjs not on disk yet — browser assertions skipped (Lead: rerun after harness-builder lands it)');
  } else {
    let testkit;
    try { testkit = await import('../lib/testkit.mjs'); }
    catch (error) { record('testkit import', false, error && error.message); testkit = null; }
    if (testkit) await runBrowserChecks(testkit);
  }

  /* --------------------------------------------------------------- summary */
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const skipped = results.filter((r) => !r.ok && /not on disk yet/.test(r.detail || '')).length;
  console.log(`\n${failed ? '✗' : '✓'} finance checks: ${passed} passed, ${failed}${skipped ? ` (${skipped} skipped awaiting testkit)` : ''} failed`);
  if (failed && !skipped) process.exitCode = 1;
  if (skipped && !failed) process.exitCode = 0;
  if (skipped && failed && failed > skipped) process.exitCode = 1;
}

/* Browser layer: drive the real SPA through the shared harness
 * (tools/lib/testkit.mjs — withApp boots Chrome + a mock Supabase and signs in).
 * The mock seeds projects, progress_billings, payments, materials, timesheets,
 * company_expenses, payment_requests and finance_settings, so the module has
 * real rows to aggregate; the deterministic statement maths are additionally
 * exercised on the live page with the same fixture used by the vm layer. */
async function runBrowserChecks(testkit) {
  if (typeof testkit.withApp !== 'function') {
    record('testkit.withApp', false, 'testkit.mjs present but exports no withApp()');
    return;
  }
  try {
    await testkit.withApp({ role: 'director' }, async (app) => {
      const { evaluate, goView, waitFor, diagnostics } = app;

      await test('withApp signs in as director and opens the finance view', async () => {
        assert(app.role === 'director', 'expected director session');
        await goView('finance');
        await waitFor(`!!document.querySelector('[data-sf-tab]')`, { label: 'finance tabs to render' });
        const state = await evaluate(`(function(){
          var m = document.getElementById('main');
          var root = m && m.querySelector('[data-sf-finance]');
          return {
            registered: !!(window.SFviews && window.SFviews.finance),
            navSection: window.SFviews && window.SFviews.finance && window.SFviews.finance.nav.section,
            root: !!root,
            tabs: root ? root.querySelectorAll('[data-sf-tab]').length : 0,
            kpis: m ? m.querySelectorAll('.kpi').length : 0
          };
        })()`);
        assert(state.registered, 'finance view not registered');
        eq(state.navSection, 'company', 'finance nav section');
        assert(state.root, 'finance view root did not render');
        eq(state.tabs, 4, 'four statement tabs (AR / AP / balance sheet / P&L)');
        assert(state.kpis >= 4, `expected KPI cards, got ${state.kpis}`);
      });

      await test('live pure API reproduces fixture AR / AP / balance-sheet / P&L totals', async () => {
        const totals = await evaluate(`(function(){
          var f = window.SF_modules && window.SF_modules.finance;
          if (!f) return null;
          var fixtures = ${JSON.stringify(FIXTURE)};
          var ar = f.arTotal(fixtures);
          var ap = f.apTotal(fixtures);
          var bs = f.balanceSheet(fixtures, { today: '${TODAY}' });
          var pnl = f.pnl(fixtures);
          var age = f.ageing([{ due_date: '2026-02-03', amount: 10 }, { due_date: '2026-02-02', amount: 20 }], { today: '${TODAY}' });
          return {
            ar: ar.ar, ap: ap.ap, assets: bs.assets, liabilities: bs.liabilities, equity: bs.equity,
            diff: bs.diff, balanced: bs.balanced, revenue: pnl.revenue, vat: pnl.vatOnRevenue,
            age30: age.d1_30, age31: age.d31_60
          };
        })()`);
        assert(totals, 'window.SF_modules.finance missing on the live page');
        near(totals.ar, 9500, 'live AR');
        near(totals.ap, 7500, 'live AP');
        near(totals.diff, 0, 'live balance identity', 0.01);
        eq(totals.balanced, true, 'live balanced flag');
        near(totals.revenue, 15000, 'live revenue excl VAT');
        near(totals.vat, 675, 'live VAT reported separately');
        near(totals.age30, 10, 'live ageing 30-day boundary');
        near(totals.age31, 20, 'live ageing 31-day boundary');
      });

      await test('CSV export helpers resist formula injection on the live page', async () => {
        const csv = await evaluate(`(function(){
          var f = window.SF_modules.finance;
          return { cell: f.csvCell('=HYPERLINK("http://evil")'), csv: f.buildCSV([['=1+1', 'PB-001', 42]]) };
        })()`);
        assert(csv.cell.charAt(0) === "'", 'live csvCell must prefix formula-leading value');
        assert(csv.csv.indexOf("'=1+1") >= 0, 'built CSV must contain the escaped formula cell');
        assert(csv.csv.indexOf('42') >= 0, 'numbers stay numeric in CSV');
      });

      await test('balance sheet tab renders the balanced identity badge in the DOM', async () => {
        const clicked = await evaluate(`(function(){
          var b = document.querySelector('[data-sf-tab="bs"]');
          if (b) b.click();
          return !!b;
        })()`);
        assert(clicked, 'balance-sheet tab button not found');
        await waitFor(`(function(){var m=document.getElementById('main');return !!m && /Balanced|متوازنة/.test(m.textContent||'');})()`, { label: 'balanced badge' });
        const text = await evaluate(`(document.getElementById('main').textContent || '')`);
        assert(/Assets − Liabilities − Equity|الأصول − الالتزامات/.test(text), 'identity row missing from DOM');
        assert(!/Imbalance|غير متوازنة/.test(text), 'unexpected imbalance badge');
        assert(/Cash and cash equivalents|النقد وما يعادله/.test(text), 'cash line missing from balance sheet');
      });

      await test('receivables / payables / P&L tabs render their sections without throwing', async () => {
        const checks = [
          { tab: 'ar', re: /Ageing|أعمار الديون/ },
          { tab: 'ap', re: /Accounts Payable|الحسابات الدائنة/ },
          { tab: 'pnl', re: /Profit & Loss|الأرباح والخسائر/ },
          { tab: 'ar', re: /Ageing|أعمار الديون/ }
        ];
        for (const check of checks) {
          await evaluate(`(function(){var b=document.querySelector('[data-sf-tab="${check.tab}"]');if(b)b.click();return true;})()`);
          const text = await evaluate(`(document.getElementById('main').textContent || '')`);
          assert(check.re.test(text), `tab ${check.tab} section heading missing`);
        }
      });

      await test('zero uncaught JS exceptions / failed requests while driving the view', async () => {
        const errors = (diagnostics && diagnostics.errors) || [];
        assert(errors.length === 0, `JS errors: ${errors.slice(0, 6).join(' | ')}`);
      });
    });
  } catch (error) {
    record('testkit browser run', false, error && error.message ? error.message : error);
  }
}

main().catch((error) => {
  console.error('\n✗ finance checks crashed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
