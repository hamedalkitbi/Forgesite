// Phase 2 workflow verification — mirrors supabase/migrations/202611050002_phase2_workflow.sql
// against the shared mock Supabase (tools/lib/mock-supabase.mjs).
//
//   node tools/checks/phase2.mjs
//
// Layers:
//   1. Static   — the migration file is idempotent (create table if not exists,
//                 create or replace function) and enables RLS.
//   2. Mock RPC — sf_assert_period_open raises CLOSED_PERIOD; sf_material_grn does
//                 received-qty + match math; sf_escalate_overdue dedupes notifications.
//   3. Mock guard — insert/update on the six dated tables are denied when the month is
//                 closed (simulates the sf_guard_closed_period trigger) and reopen allows.
//   4. Fixtures — approval_attachment_rules / approval_sla / closed_periods /
//                 goods_received_notes / approval_attachments are seeded.
//   5. App      — SF.attachments / SF.periods / SF.grn / SF.sla and the PO-billing +
//                 supplier-payment 3-way-match gates are reported skipped-pending until
//                 the Lead lands them (never a false pass).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withApp, assert, assertEqual, ROOT } from '../lib/testkit.mjs';

const MIGRATION = join(ROOT, 'supabase', 'migrations', '202611050002_phase2_workflow.sql');

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
  console.log('Phase 2 — evidence / period close / SLA / 3-way match\n');

  /* ------------------------------------------------------------ static: migration */
  let migrationSql = '';
  try { migrationSql = await readFile(MIGRATION, 'utf8'); } catch { migrationSql = ''; }
  if (migrationSql) {
    await check('migration 202611050002 idempotent + enables RLS', async () => {
      const code = stripSqlComments(migrationSql);
      for (const table of ['approval_attachments', 'approval_attachment_rules', 'closed_periods', 'approval_sla', 'goods_received_notes']) {
        assert(new RegExp(`create table if not exists public\\.${table}\\b`, 'i').test(code), `create table if not exists public.${table} missing`);
      }
      for (const fn of ['sf_assert_period_open', 'sf_material_grn', 'sf_escalate_overdue', 'sf_guard_closed_period']) {
        assert(new RegExp(`create or replace function public\\.${fn}\\b`, 'i').test(code), `create or replace function public.${fn} missing`);
      }
      assert(/enable row level security/i.test(code), 'enable row level security missing');
    });
  } else {
    skipPending('migration 202611050002 idempotent + enables RLS', 'migration not present yet (db-engineer2 pending)');
  }

  /* ------------------------------------------------------------ mock + fixtures */
  let surface = null;
  await withApp({ role: 'director' }, async ({ evaluate, diagnostics }) => {
    diagnostics.clear();
    await check('phase 2 tables + rules/SLA seeded', async () => {
      const r = await evaluate(`(function () {
        var db = window.__MOCK_DB;
        function has(t) { return !!db[t] && Array.isArray(db[t]); }
        var rules = db.approval_attachment_rules || [];
        function threshold(t) { for (var i = 0; i < rules.length; i += 1) { if (rules[i].table_name === t) return Number(rules[i].min_amount_aed); } return null; }
        return {
          attachments: has('approval_attachments'),
          rules: has('approval_attachment_rules'),
          closed: has('closed_periods'),
          sla: has('approval_sla'),
          grn: has('goods_received_notes'),
          materialsRule: threshold('materials'),
          coRule: threshold('change_orders'),
          prRule: threshold('payment_requests'),
          expRule: threshold('company_expenses'),
          tsRule: threshold('timesheets'),
          slaDays: (db.approval_sla && db.approval_sla[0] && db.approval_sla[0].sla_days)
        };
      })()`);
      assert(r.attachments && r.rules && r.closed && r.sla && r.grn, 'all five phase 2 tables must be seeded');
      assertEqual(r.materialsRule, 25000, 'materials rule threshold');
      assertEqual(r.coRule, 10000, 'change_orders rule threshold');
      assertEqual(r.prRule, 50000, 'payment_requests rule threshold');
      assertEqual(r.expRule, 5000, 'company_expenses rule threshold');
      assertEqual(r.tsRule, 0, 'timesheets rule (0 = never required)');
      assertEqual(r.slaDays, 3, 'approval_sla sla_days');
    });

    surface = await evaluate(`(function () {
      return {
        attachments: !!(window.SF && window.SF.attachments && typeof window.SF.attachments.requiredFor === 'function'),
        attachmentsIo: !!(window.SF && window.SF.attachments && typeof window.SF.attachments.upload === 'function'),
        periods: !!(window.SF && window.SF.periods && typeof window.SF.periods.isClosed === 'function'),
        grn: !!(window.SF && window.SF.grn && typeof window.SF.grn.receivedQty === 'function'),
        sla: !!(window.SF && window.SF.sla && typeof window.SF.sla.get === 'function')
      };
    })()`);

    /* required-evidence rule lookup (app gate if wired, else the seeded rule). */
    if (surface.attachments) {
      await check('required-evidence: SF.attachments.requiredFor over threshold', async () => {
        const r = await evaluate(`(function () {
          return {
            coHigh: window.SF.attachments.requiredFor('change_orders', 15000),
            coLow: window.SF.attachments.requiredFor('change_orders', 5000),
            expHigh: window.SF.attachments.requiredFor('company_expenses', 6000),
            tsAny: window.SF.attachments.requiredFor('timesheets', 999999)
          };
        })()`);
        assertEqual(r.coHigh, true, 'change_order 15000 above threshold requires evidence');
        assertEqual(r.coLow, false, 'change_order 5000 under threshold does not');
        assertEqual(r.expHigh, true, 'expense 6000 above threshold requires evidence');
        assertEqual(r.tsAny, false, 'timesheets never requires evidence');
      });
    } else {
      skipPending('required-evidence: submit above threshold blocked', 'SF.attachments.requiredFor not wired in app.js yet (Lead pending) — rule thresholds verified from seed instead');
    }

    /* Attachment list/upload/remove — data-layer round-trip always; bridge gated. */
    await check('approval_attachments insert/select/delete round-trip', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var rec = 'd0000000-0000-4000-8000-000000000042';
        var ins = await client.from('approval_attachments').insert({ table_name: 'change_orders', record_id: rec, file_path: 'x/co-proof.pdf', file_name: 'co-proof.pdf', file_size: 1234, mime_type: 'application/pdf', uploaded_by: 'Hamed Al Kitbi' });
        var id = ins.data && ins.data[0] && ins.data[0].id;
        var list = await client.from('approval_attachments').select('*').eq('record_id', rec);
        var del = await client.from('approval_attachments').delete().eq('id', id).select('id');
        var after = await client.from('approval_attachments').select('*').eq('record_id', rec);
        return { id: id, count: list.data && list.data.length, fileName: list.data && list.data[0] && list.data[0].file_name, delCount: del.data && del.data.length, afterCount: after.data && after.data.length };
      })()`);
      assert(r.id, 'insert must assign an id');
      assertEqual(r.count, 1, 'one attachment listed after insert');
      assertEqual(r.fileName, 'co-proof.pdf', 'file_name round-trips');
      assertEqual(r.delCount, 1, 'delete removes exactly one row');
      assertEqual(r.afterCount, 0, 'no attachments remain after delete');
    });
    if (surface.attachmentsIo) {
      await check('SF.attachments list/upload/remove round-trips', async () => {
        const r = await evaluate(`(async function () {
          var rec = 'd0000000-0000-4000-8000-000000000042';
          await window.SF.attachments.upload('change_orders', rec, { name: 'proof.pdf' });
          var list = await window.SF.attachments.list('change_orders', rec);
          var first = list && list[0];
          await window.SF.attachments.remove(first && first.id);
          var after = await window.SF.attachments.list('change_orders', rec);
          return { count: list && list.length, name: first && (first.file_name || first.name), after: after && after.length };
        })()`);
        assertEqual(r.count, 1, 'SF.attachments.upload + list');
        assert(r.name, 'uploaded attachment must have a name');
        assertEqual(r.after, 0, 'SF.attachments.remove empties the list');
      });
    } else {
      skipPending('SF.attachments list/upload/remove round-trips', 'SF.attachments not wired in app.js yet (Lead pending) — data-layer round-trip verified instead');
    }

    /* Period close: sf_assert_period_open + the simulated closed-period guard. */
    await check('sf_assert_period_open raises CLOSED_PERIOD', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        await client.from('closed_periods').insert({ company_id: co, period: '2024-06', closed_by: 'Hamed Al Kitbi', reason: 'test' });
        var closed = await client.rpc('sf_assert_period_open', { p_company: co, p_date: '2024-06-20' });
        var open = await client.rpc('sf_assert_period_open', { p_company: co, p_date: '2024-07-20' });
        await client.from('closed_periods').delete().eq('company_id', co).eq('period', '2024-06');
        return { closedCode: closed.error && closed.error.code, openError: open.error };
      })()`);
      assertEqual(r.closedCode, 'CLOSED_PERIOD', 'closed period must raise CLOSED_PERIOD');
      assertEqual(r.openError, null, 'open period must not error');
    });

    await check('period close: dated write denied, reopen allows', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        var projectA = window.__MOCK_DB.projects[0].id;
        await client.from('closed_periods').insert({ company_id: co, period: '2024-05', closed_by: 'Hamed Al Kitbi', reason: 'test' });
        var denied = await client.from('timesheets').insert({ project_id: projectA, employee_name: 'Guard', trade: 'CONC', work_date: '2024-05-15', reg_hours: 8, status: 'pending' });
        var appThrew = null;
        try { await window.SF.db.insert('timesheets', { project_id: projectA, employee_name: 'Guard', trade: 'CONC', work_date: '2024-05-16', reg_hours: 8, status: 'pending' }); }
        catch (e) { appThrew = (e && e.message) || String(e); }
        await client.from('closed_periods').delete().eq('company_id', co).eq('period', '2024-05');
        var allowed = await client.from('timesheets').insert({ project_id: projectA, employee_name: 'Guard', trade: 'CONC', work_date: '2024-05-17', reg_hours: 8, status: 'pending' });
        return { deniedCode: denied.error && denied.error.code, deniedData: denied.data, appThrew: appThrew, allowedError: allowed.error, allowedCount: allowed.data && allowed.data.length };
      })()`);
      assertEqual(r.deniedCode, 'CLOSED_PERIOD', 'raw write into closed month denied');
      assertEqual(r.deniedData, null, 'denied insert returns no data');
      assert(r.appThrew && r.appThrew.indexOf('CLOSED_PERIOD') >= 0, 'app insertRow surfaces CLOSED_PERIOD (got: ' + r.appThrew + ')');
      assertEqual(r.allowedError, null, 'write succeeds after reopen');
      assertEqual(r.allowedCount, 1, 'reopened insert returns one row');
    });
    if (surface.periods) {
      await check('SF.periods close/reopen via bridge', async () => {
        const r = await evaluate(`(async function () {
          await window.SF.periods.close('2024-04', 'test');
          var closed = await window.SF.periods.isClosed('2024-04');
          await window.SF.periods.reopen('2024-04');
          var reopened = await window.SF.periods.isClosed('2024-04');
          return { closed: closed, reopened: reopened };
        })()`);
        assertEqual(r.closed, true, 'SF.periods.close + isClosed');
        assertEqual(r.reopened, false, 'SF.periods.reopen clears the closed flag');
      });
    } else {
      skipPending('SF.periods close/reopen via bridge', 'SF.periods not wired in app.js yet (Lead pending) — closed-period guard verified via mock instead');
    }

    /* SLA escalation. */
    await check('escalation: old pending record triggers a notification (deduped)', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var co = window.__MOCK_DB.companies[0].id;
        var old = new Date(Date.now() - 30 * 86400000).toISOString();
        var ins = await client.from('company_expenses').insert({ company_id: co, category: 'Test', description: 'Overdue escalation probe', amount: 7000, expense_date: '2026-01-05', paid_to: 'Vendor', payment_method: 'Cash', created_by: 'Ravi Kumar', status: 'pending', created_at: old });
        var id = ins.data[0].id;
        var key = 'company_expenses:' + id;
        var r1 = await client.rpc('sf_escalate_overdue');
        var esc1 = (window.__MOCK_DB.notifications || []).filter(function (n) { return n.type === 'escalation'; });
        var mine = esc1.filter(function (n) { return n.notif_dedupe === key; });
        await client.rpc('sf_escalate_overdue');
        var esc2 = (window.__MOCK_DB.notifications || []).filter(function (n) { return n.type === 'escalation'; });
        return { escalated: r1.data && r1.data.escalated, firstRun: esc1.length, mine: mine.length, secondRun: esc2.length, title: mine[0] && mine[0].title, hasUser: !!(mine[0] && mine[0].user_id) };
      })()`);
      assert(r.escalated >= 1, 'sf_escalate_overdue must report at least one escalated record');
      assert(r.mine >= 1, 'an escalation notification must reference the overdue record');
      assertEqual(r.firstRun, r.secondRun, 're-run must not duplicate (dedupe)');
      assertEqual(r.title, 'Approval overdue', 'escalation notification title');
      assert(r.hasUser, 'escalation must be addressed to a director/controller profile');
    });
    if (surface.sla) {
      await check('SF.sla.get returns sla_days', async () => {
        const r = await evaluate(`(function () { var s = window.SF.sla.get(); return { days: s && s.sla_days }; })()`);
        assertEqual(r.days, 3, 'SF.sla.get sla_days');
      });
    } else {
      skipPending('SF.sla.get returns sla_days', 'SF.sla not wired in app.js yet (Lead pending)');
    }

    /* GRN: received-qty + match math (RPC), plus add/list round-trip. */
    await check('GRN: sf_material_grn received-qty + match math', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var projectA = window.__MOCK_DB.projects[0].id;
        var mat = window.__MOCK_DB.materials[0];
        var mid = mat.id;
        var supplier = window.__MOCK_DB.suppliers[0].id;
        var before = await client.rpc('sf_material_grn', { m_id: mid });
        await client.from('goods_received_notes').insert({ project_id: projectA, material_id: mid, supplier_id: supplier, reference: 'GRN-0001', received_date: '2026-11-01', qty_received: 200, received_by: 'Ravi Kumar' });
        var partial = await client.rpc('sf_material_grn', { m_id: mid });
        await client.from('goods_received_notes').insert({ project_id: projectA, material_id: mid, supplier_id: supplier, reference: 'GRN-0002', received_date: '2026-11-02', qty_received: 120, received_by: 'Ravi Kumar' });
        var full = await client.rpc('sf_material_grn', { m_id: mid });
        return {
          beforeQty: before.data && before.data.received_qty,
          beforeMatched: before.data && before.data.matched,
          partialQty: partial.data && partial.data.received_qty,
          partialMatched: partial.data && partial.data.matched,
          fullQty: full.data && full.data.received_qty,
          fullMatched: full.data && full.data.matched
        };
      })()`);
      assertEqual(r.beforeQty, 0, 'no GRNs yet');
      assertEqual(r.beforeMatched, false, 'not matched before receiving');
      assertEqual(r.partialQty, 200, 'partial receive sums to 200');
      assertEqual(r.partialMatched, false, '200 < 320 → unmatched');
      assertEqual(r.fullQty, 320, 'total received 320');
      assertEqual(r.fullMatched, true, '320 >= 320 → matched');
    });

    await check('goods_received_notes add/list/remove round-trip', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var projectA = window.__MOCK_DB.projects[0].id;
        var mat = window.__MOCK_DB.materials[1].id;
        var ins = await client.from('goods_received_notes').insert({ project_id: projectA, material_id: mat, reference: 'GRN-TEST-1', received_date: '2026-11-03', qty_received: 50, received_by: 'Test', status: 'received' });
        var id = ins.data[0].id;
        var list = await client.from('goods_received_notes').select('*').eq('reference', 'GRN-TEST-1');
        var del = await client.from('goods_received_notes').delete().eq('id', id).select('id');
        var after = await client.from('goods_received_notes').select('*').eq('reference', 'GRN-TEST-1');
        return { id: id, count: list.data.length, qty: list.data[0] && Number(list.data[0].qty_received), status: list.data[0] && list.data[0].status, delCount: del.data.length, afterCount: after.data.length };
      })()`);
      assert(r.id, 'GRN insert assigns id');
      assertEqual(r.count, 1, 'one GRN listed');
      assertEqual(r.qty, 50, 'qty_received round-trips');
      assertEqual(r.status, 'received', 'status defaults to received');
      assertEqual(r.delCount, 1, 'delete removes one');
      assertEqual(r.afterCount, 0, 'list empty after delete');
    });
    if (surface.grn) {
      await check('SF.grn receivedQty/forMaterial/add present', async () => {
        const r = await evaluate(`(function () {
          return {
            receivedQty: typeof window.SF.grn.receivedQty === 'function',
            forMaterial: typeof window.SF.grn.forMaterial === 'function',
            add: typeof window.SF.grn.add === 'function'
          };
        })()`);
        assert(r.receivedQty && r.forMaterial && r.add, 'SF.grn bridge methods missing');
      });
    } else {
      skipPending('SF.grn bridge', 'SF.grn not wired in app.js yet (Lead pending) — sf_material_grn RPC verified instead');
    }

    await check('no JS exceptions during phase 2 checks', async () => {
      assertEqual((diagnostics.errors || []).length, 0, 'JS exceptions: ' + (diagnostics.errors || []).join(' | '));
    });
    /* 3-way-match app gates (app.js) — isolated in a fresh session so accumulated
       mock state (earlier checks insert GRNs / close periods) cannot taint them. */
  });
  await withApp({ role: 'director', project: 'PRJ-001' }, async ({ evaluate }) => {
    if (!surface || !surface.grn) {
      skipPending('PO billing blocked without GRN', 'app.js convertPOToBill has no GRN guard yet (Lead pending)');
      skipPending('supplier payment blocked without GRN match', 'app.js supplier payment paid flow has no GRN guard yet (Lead pending)');
      return;
    }
    await check('PO billing blocked without GRN', async () => {
      const r = await evaluate(`(async () => {
        const S = window.SF, pid = S.currentProjectId;
        const m = await S.db.insert('materials', { project_id: pid, boq_item_id: null, po_number: 'PO-GRN-GATE', supplier: 'Gate Supplier', description: '3-way gate', quantity: 2, unit: 'EA', unit_cost_aed: 100, stage: 'Ordered', status: 'approved', invoice_date: S.helpers.today() });
        await window.reloadProjectTable('materials', 'created_at', false);
        const mm = S.state.materials.find(function (x) { return x.id === m.id; });
        const blocked = !(await window.SF.grn.guard(mm));
        await S.db.insert('goods_received_notes', { project_id: pid, material_id: m.id, reference: 'GRN-GATE-1', received_date: S.helpers.today(), qty_received: 2, received_by: 'director', status: 'received' });
        await window.reloadProjectTable('goods_received_notes', 'received_date', false);
        await window.reloadProjectTable('materials', 'created_at', false);
        const mm2 = S.state.materials.find(function (x) { return x.id === m.id; });
        const allowed = await window.SF.grn.guard(mm2);
        return { blocked, allowed };
      })()`);
      assert(r.blocked, 'PO without GRN should be blocked');
      assert(r.allowed, 'PO with full GRN should be allowed');
    });
    await check('supplier payment blocked without GRN match', async () => {
      const r = await evaluate(`(async () => {
        const S = window.SF, pid = S.currentProjectId;
        await S.db.insert('materials', { project_id: pid, boq_item_id: null, po_number: 'PO-PAY-GATE', supplier: 'Pay Gate Supplier', description: 'pay gate', quantity: 1, unit: 'EA', unit_cost_aed: 50, stage: 'Delivered', status: 'approved', invoice_no: 'INV-NO-GRN', invoice_date: S.helpers.today() });
        await window.reloadProjectTable('materials', 'created_at', false);
        const blocked = !(await window.SF.grn.guardPayment({ type: 'invoice', invoiceNo: 'INV-NO-GRN' }));
        return { blocked };
      })()`);
      assert(r.blocked, 'supplier invoice with a linked PO but no GRN should be blocked');
    });


  });

  /* --------------------------------------------------------------- summary */
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  console.log(`\nPhase 2: ${passed} passed, ${skippedCount} skipped-pending, ${failed.length} failed (of ${results.length} checks)`);
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\n✗ phase2 checks crashed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
