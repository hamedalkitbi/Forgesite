// Phase 1 accountability verification — mirrors supabase/migrations/202611050001_phase1_accountability.sql
// against the shared mock Supabase (tools/lib/mock-supabase.mjs).
//
//   node tools/checks/phase1.mjs
//
// Layers:
//   1. Static   — the migration file is idempotent (create table if not exists,
//                 add column if not exists, create or replace function) and enables RLS.
//   2. Mock RPC — sf_approve_record / sf_reject_record enforce role, limits of
//                 authority, segregation of duties, reject-reason and CAS double-approve,
//                 and write an approval_events row.
//   3. Fixtures — the global supplier master + project_suppliers link are seeded.
//   4. App      — SF.db.rpc / SF.approvals / inbox and the suppliers module are reported
//                 skipped-pending until their owners land them (never a false pass).
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withApp, assert, assertEqual, ROOT } from '../lib/testkit.mjs';

const MIGRATION = join(ROOT, 'supabase', 'migrations', '202611050001_phase1_accountability.sql');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? '\n      ' + String(detail).replace(/\n/g, '\n      ') : ''}`);
}
async function check(name, fn) {
  try { await fn(); record(name, true); }
  catch (error) { record(name, false, error && error.message ? error.message : error); }
}
function skipPending(name, reason) {
  results.push({ name, ok: true, skipped: true, detail: reason });
  console.log(`  ⏭ ${name} — skipped-pending: ${reason}`);
}
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

async function main() {
  console.log('Phase 1 accountability — checks\n');

  /* ------------------------------------------------------------ static: migration */
  await check('migration file exists (db-engineer)', async () => {
    const info = await stat(MIGRATION);
    assert(info.size > 500, 'migration suspiciously small');
  });
  await check('migration is idempotent and enables RLS', async () => {
    let sql;
    try { sql = await readFile(MIGRATION, 'utf8'); }
    catch (error) { throw new Error('migration not present yet — idempotency not verifiable (db-engineer pending)'); }
    const code = stripSqlComments(sql);
    for (const table of ['suppliers', 'project_suppliers', 'approval_limits', 'approval_events']) {
      assert(new RegExp(`create table if not exists public\\.${table}\\b`, 'i').test(code), `create table if not exists public.${table} missing`);
    }
    assert((code.match(/add column if not exists created_by/gi) || []).length >= 5, 'add column if not exists created_by must cover materials/boq_items/change_orders/timesheets/company_expenses');
    for (const fn of ['sf_current_role', 'sf_current_user', 'sf_approve_record', 'sf_reject_record']) {
      assert(new RegExp(`create or replace function public\\.${fn}\\b`, 'i').test(code), `create or replace function public.${fn} missing`);
    }
    assert(/enable row level security/i.test(code), 'enable row level security missing');
  });

  /* ------------------------------------------------------------ fixtures + RPC rules */
  await withApp({ role: 'director' }, async ({ evaluate, goView, diagnostics }) => {
    await check('supplier master + project_suppliers link are seeded', async () => {
      const r = await evaluate(`(function () {
        var db = window.__MOCK_DB;
        var suppliers = db.suppliers || [];
        var links = db.project_suppliers || [];
        var projectA = (db.projects && db.projects[0] && db.projects[0].id) || null;
        var linked = !!projectA && links.some(function (l) {
          return l.project_id === projectA && suppliers.some(function (s) { return s.id === l.supplier_id; });
        });
        return {
          supplierCount: suppliers.length,
          linkCount: links.length,
          linked: linked,
          master: suppliers.some(function (s) { return s.name === 'Emirates Ready Mix'; }),
          subcontractor: suppliers.some(function (s) { return s.kind === 'subcontractor'; })
        };
      })()`);
      assert(r.supplierCount >= 4, 'expected at least 4 suppliers, got ' + r.supplierCount);
      assert(r.linkCount >= 1, 'expected at least one project_suppliers link');
      assert(r.linked, 'project_suppliers must link a real supplier to project A');
      assert(r.master, 'global master must contain Emirates Ready Mix');
      assert(r.subcontractor, 'master must include a subcontractor kind');
    });

    const surface = await evaluate(`(function () {
      return {
        dbRpc: !!(window.SF && window.SF.db && typeof window.SF.db.rpc === 'function'),
        approvals: !!(window.SF && window.SF.approvals),
        inbox: !!(window.SF && window.SF.ui && typeof window.SF.ui.openApprovalsInbox === 'function'),
        suppliersView: !!(window.SFviews && window.SFviews.suppliers)
      };
    })()`);
    if (surface.dbRpc) record('SF.db.rpc bridge present', true);
    else skipPending('SF.db.rpc bridge present', 'SF.db.rpc not wired in app.js yet (Lead pending)');
    if (surface.approvals) record('SF.approvals bridge present', true);
    else skipPending('SF.approvals bridge present', 'SF.approvals not wired in app.js yet (Lead pending)');
    if (surface.inbox) record('SF.ui.openApprovalsInbox bridge present', true);
    else skipPending('SF.ui.openApprovalsInbox bridge present', 'approvals inbox not wired in app.js yet (Lead pending)');

    await check('SoD denial: creator cannot approve their own submission', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        var ins = await client.from('company_expenses').insert({ company_id: co, category: 'Test', description: 'SoD self-approve', amount: 1000, expense_date: '2026-11-04', paid_to: 'Self', payment_method: 'Cash', created_by: 'Hamed Al Kitbi', status: 'pending' });
        var id = ins.data[0].id;
        var res = await client.rpc('sf_approve_record', { p_table: 'company_expenses', p_id: id, p_reason: null });
        var row = await client.from('company_expenses').select('status').eq('id', id).single();
        return { ok: res.data && res.data.ok, code: res.data && res.data.code, message: res.data && res.data.message, error: res.error, status: row.data && row.data.status };
      })()`);
      assertEqual(r.error, null, 'rpc must resolve without a transport error');
      assertEqual(r.ok, false, 'self-approval must be denied');
      assertEqual(r.code, 'sod', 'SoD denial code');
      assertEqual(r.status, 'pending', 'record must stay pending after SoD denial');
    });

    await check('reject requires a reason', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        var ins = await client.from('company_expenses').insert({ company_id: co, category: 'Test', description: 'Reject without reason', amount: 1500, expense_date: '2026-11-04', paid_to: 'Vendor', payment_method: 'Cash', created_by: 'Ravi Kumar', status: 'pending' });
        var id = ins.data[0].id;
        var res = await client.rpc('sf_reject_record', { p_table: 'company_expenses', p_id: id, p_reason: null });
        return { ok: res.data && res.data.ok, code: res.data && res.data.code, error: res.error };
      })()`);
      assertEqual(r.error, null, 'rpc must resolve without a transport error');
      assertEqual(r.ok, false, 'reject without reason must be denied');
      assertEqual(r.code, 'reason_required', 'reason_required code');
    });

    await check('CAS: double-approve is denied and status is unchanged', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        var ins = await client.from('company_expenses').insert({ company_id: co, category: 'Test', description: 'Double approve', amount: 2000, expense_date: '2026-11-04', paid_to: 'Vendor', payment_method: 'Cash', created_by: 'Ravi Kumar', status: 'pending' });
        var id = ins.data[0].id;
        var first = await client.rpc('sf_approve_record', { p_table: 'company_expenses', p_id: id, p_reason: null });
        var second = await client.rpc('sf_approve_record', { p_table: 'company_expenses', p_id: id, p_reason: null });
        var row = await client.from('company_expenses').select('status').eq('id', id).single();
        return { firstOk: first.data && first.data.ok, firstStatus: first.data && first.data.status, secondOk: second.data && second.data.ok, secondCode: second.data && second.data.code, status: row.data && row.data.status };
      })()`);
      assertEqual(r.firstOk, true, 'first approve must succeed');
      assertEqual(r.firstStatus, 'approved', 'first approve status');
      assertEqual(r.secondOk, false, 'second approve must be denied');
      assertEqual(r.secondCode, 'already_decided', 'already_decided code');
      assertEqual(r.status, 'approved', 'status must remain approved');
    });

    await check('approval_events row written (action/amount/actor)', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        var ins = await client.from('company_expenses').insert({ company_id: co, category: 'Test', description: 'Events log', amount: 2500, expense_date: '2026-11-04', paid_to: 'Vendor', payment_method: 'Cash', created_by: 'Ravi Kumar', status: 'pending' });
        var id = ins.data[0].id;
        var res = await client.rpc('sf_approve_record', { p_table: 'company_expenses', p_id: id, p_reason: null });
        var events = (window.__MOCK_DB.approval_events || []).filter(function (e) { return e.table_name === 'company_expenses' && e.record_id === id; });
        var dir = (window.__MOCK_DB.profiles || []).filter(function (p) { return p.role === 'director'; })[0];
        return { ok: res.data && res.data.ok, count: events.length, action: events[0] && events[0].action, amount: events[0] && Number(events[0].amount_aed), actorName: events[0] && events[0].actor_name, actorRole: events[0] && events[0].actor_role, actorId: events[0] && events[0].actor_id, dirId: dir && dir.id, fromStatus: events[0] && events[0].from_status, toStatus: events[0] && events[0].to_status };
      })()`);
      assertEqual(r.ok, true, 'approve must succeed');
      assertEqual(r.count, 1, 'exactly one approval_events row');
      assertEqual(r.action, 'approve', 'event action');
      assertEqual(r.amount, 2500, 'event amount');
      assertEqual(r.actorName, 'Hamed Al Kitbi', 'event actor name');
      assertEqual(r.actorRole, 'director', 'event actor role');
      assertEqual(r.actorId, r.dirId, 'event actor id = director profile id');
      assertEqual(r.fromStatus, 'pending', 'event from_status');
      assertEqual(r.toStatus, 'approved', 'event to_status');
    });

    await check('director is unlimited (approves over controller limit)', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        var ins = await client.from('company_expenses').insert({ company_id: co, category: 'Test', description: 'Director unlimited', amount: 300000, expense_date: '2026-11-04', paid_to: 'Vendor', payment_method: 'Cash', created_by: 'Ravi Kumar', status: 'pending' });
        var id = ins.data[0].id;
        var res = await client.rpc('sf_approve_record', { p_table: 'company_expenses', p_id: id, p_reason: null });
        var row = await client.from('company_expenses').select('status').eq('id', id).single();
        return { ok: res.data && res.data.ok, code: res.data && res.data.code, status: row.data && row.data.status };
      })()`);
      assertEqual(r.ok, true, 'director must bypass limits');
      assertEqual(r.status, 'approved', 'director approve status');
    });

    if (surface.suppliersView) {
      await check('suppliers module view renders with zero exceptions', async () => {
        diagnostics.clear();
        const active = await goView('suppliers');
        const text = await evaluate(`(document.getElementById('main').textContent || '')`);
        assertEqual(active, 'suppliers', 'suppliers view did not become active');
        assert(text.trim().length > 0, 'suppliers view rendered empty');
        assertEqual((diagnostics.errors || []).length, 0, 'JS exceptions while rendering suppliers');
      });
    } else {
      skipPending('suppliers module view renders with zero exceptions', 'scripts/modules/suppliers.js present but not loaded by index.html (Lead pending wiring)');
    }
  });

  /* ------------------------------------------------------------ controller limits */
  await withApp({ role: 'controller' }, async ({ evaluate }) => {
    await check('controller over limit is denied (fail closed)', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        var ins = await client.from('company_expenses').insert({ company_id: co, category: 'Test', description: 'Controller over limit', amount: 120000, expense_date: '2026-11-04', paid_to: 'Vendor', payment_method: 'Cash', created_by: 'Ravi Kumar', status: 'pending' });
        var id = ins.data[0].id;
        var res = await client.rpc('sf_approve_record', { p_table: 'company_expenses', p_id: id, p_reason: null });
        var row = await client.from('company_expenses').select('status').eq('id', id).single();
        return { ok: res.data && res.data.ok, code: res.data && res.data.code, message: res.data && res.data.message, status: row.data && row.data.status };
      })()`);
      assertEqual(r.ok, false, 'controller over limit must be denied');
      assertEqual(r.code, 'over_limit', 'over_limit code');
      assertEqual(r.status, 'pending', 'record must stay pending');
    });

    await check('controller within limit approves', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        var ins = await client.from('company_expenses').insert({ company_id: co, category: 'Test', description: 'Controller within limit', amount: 10000, expense_date: '2026-11-04', paid_to: 'Vendor', payment_method: 'Cash', created_by: 'Ravi Kumar', status: 'pending' });
        var id = ins.data[0].id;
        var res = await client.rpc('sf_approve_record', { p_table: 'company_expenses', p_id: id, p_reason: null });
        return { ok: res.data && res.data.ok, status: res.data && res.data.status, code: res.data && res.data.code };
      })()`);
      assertEqual(r.ok, true, 'controller within limit must approve');
      assertEqual(r.status, 'approved', 'controller approve status');
    });
  });

  /* ------------------------------------------------------------ non-manager role */
  await withApp({ role: 'lead' }, async ({ evaluate }) => {
    await check('non-manager role (lead) is denied by the RPC', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        var ins = await client.from('company_expenses').insert({ company_id: co, category: 'Test', description: 'Lead role denial', amount: 100, expense_date: '2026-11-04', paid_to: 'Vendor', payment_method: 'Cash', created_by: 'Ravi Kumar', status: 'pending' });
        var id = ins.data[0].id;
        var res = await client.rpc('sf_approve_record', { p_table: 'company_expenses', p_id: id, p_reason: null });
        return { ok: res.data && res.data.ok, code: res.data && res.data.code };
      })()`);
      assertEqual(r.ok, false, 'lead must be denied');
      assertEqual(r.code, 'forbidden', 'forbidden code');
    });
  });

  /* --------------------------------------------------------------- summary */
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  console.log(`\nPhase 1: ${passed} passed, ${skippedCount} skipped-pending, ${failed.length} failed (of ${results.length} checks)`);
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\n✗ phase1 checks crashed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
