// Verification for the workflow-upgrade wave (native port of the v28-era patch spec):
// notification/alert dismissal, commitments vs actuals, PO -> supplier bill, variation BOQ
// lines, worker-linked timesheets, unified payroll run, BOQ valuation sheet, IPC -> AR sync,
// cross-project approvals queue, WebP photo pipeline and the monolith compatibility surface.
//
// Usage: node tools/checks/upgrade-wave.mjs
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withApp, assert, assertEqual, ROOT } from '../lib/testkit.mjs';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name} — ${error.message}`);
  }
}

async function main() {
  const appSource = await readFile(join(ROOT, 'scripts/app.js'), 'utf8');

  await withApp({ role: 'director', project: 'PRJ-001' }, async ({ evaluate, waitFor }) => {
    // ---------------------------------------------------------------- compatibility
    await check('monolith compatibility surface exists (fixes the st.boq TypeError)', async () => {
      const r = await evaluate(`(() => ({
        siteForge: typeof window.SiteForge,
        stateIsObject: typeof window.state === 'object' && Array.isArray(window.state.boq),
        sfStateSame: window.SF.state === window.state,
        helpers: ['esc','money','money0','fmtDate','today','toast','openModal','closeModal','updateRow','insertRow']
          .filter((k) => typeof window.SiteForge[k] !== 'function')
      }))()`);
      assertEqual(r.siteForge, 'object', 'window.SiteForge');
      assert(r.stateIsObject, 'window.state must expose the live state (boq array)');
      assert(r.sfStateSame, 'SF.state and window.state must be the same object');
      assertEqual(r.helpers.length, 0, 'missing SiteForge helpers: ' + r.helpers.join(','));
    });

    // ------------------------------------------------------- commitments vs actuals
    await check('commitments vs actuals split by PO stage', async () => {
      const r = await evaluate(`(async () => {
        const S = window.SF, pid = S.currentProjectId;
        const boq = S.state.boq[0];
        const before = { act: window.getBoqActualsMap()[boq.id] || 0, com: window.getBoqCommittedMap()[boq.id] || 0 };
        const row = await S.db.insert('materials', { project_id: pid, boq_item_id: boq.id, po_number: 'PO-VERIFY-1', supplier: 'Verify Supplier', description: 'Commitment test', quantity: 2, unit: 'EA', unit_cost_aed: 100, stage: 'Ordered', status: 'approved', invoice_date: S.helpers.today() });
        await window.reloadProjectTable('materials', 'created_at', false);
        const ordered = { act: window.getBoqActualsMap()[boq.id] || 0, com: window.getBoqCommittedMap()[boq.id] || 0 };
        await S.db.update('materials', row.id, { stage: 'Delivered' });
        await window.reloadProjectTable('materials', 'created_at', false);
        const delivered = { act: window.getBoqActualsMap()[boq.id] || 0, com: window.getBoqCommittedMap()[boq.id] || 0 };
        return { before, ordered, delivered, materialId: row.id, qty: 2, cost: 100 };
      })()`);
      assertEqual(r.ordered.com - r.before.com, 200, 'ordered PO adds 2 x 100 to committed');
      assertEqual(r.ordered.act, r.before.act, 'ordered PO must not add to actuals');
      assertEqual(r.delivered.act - r.ordered.act, 200, 'delivered PO moves 200 into actuals');
      assertEqual(r.delivered.com, r.ordered.com - 200, 'committed releases on delivery');
    });

    // ------------------------------------------------------------ PO -> supplier bill
    let poMaterialId = null;
    await check('convertPOToBill computes 5% VAT + 30-day terms', async () => {
      const r = await evaluate(`(async () => {
        const S = window.SF, pid = S.currentProjectId;
        const boq = S.state.boq[0];
        const row = await S.db.insert('materials', { project_id: pid, boq_item_id: boq.id, po_number: 'PO-BILL-1', supplier: 'Gulf Materials LLC', description: 'Bill test', quantity: 3, unit: 'EA', unit_cost_aed: 1000, stage: 'Ordered', status: 'approved', invoice_date: S.helpers.today() });
        await window.reloadProjectTable('materials', 'created_at', false);
        window.convertPOToBill(row.id);
        const due = document.getElementById('po_bill_due').value;
        const sub = Number(document.getElementById('po_bill_sub').value);
        const tot = Number(document.getElementById('po_bill_tot').value);
        const expectedDue = new Date(); expectedDue.setDate(expectedDue.getDate() + 30);
        const exp = expectedDue.getFullYear() + '-' + String(expectedDue.getMonth() + 1).padStart(2, '0') + '-' + String(expectedDue.getDate()).padStart(2, '0');
        await window.commitPOBill(row.id);
        await new Promise((res) => setTimeout(res, 200));
        const pays = await S.db.select('payments', { invoice_no: 'BILL-PO-BILL-1' });
        const mats = await S.db.select('materials', { id: row.id });
        return { sub, tot, due, exp, materialId: row.id, paymentType: pays[0] && pays[0].payment_type, paymentStatus: pays[0] && pays[0].status, stage: mats[0] && mats[0].stage };
      })()`);
      assertEqual(r.sub, 3000, 'subtotal 3 x 1000');
      assertEqual(r.tot, 3150, '5% VAT => 3150');
      assertEqual(r.due, r.exp, 'due date is today + 30 days');
      assertEqual(r.paymentType, 'invoice', 'posted as supplier invoice');
      assertEqual(r.paymentStatus, 'pending', 'unpaid payable');
      assertEqual(r.stage, 'Inspected', 'ordered PO accrues once billed');
      poMaterialId = r.materialId;
    });

    // -------------------------------------------------- variation line on CO approval
    await check('approved change order creates a BOQ variation line', async () => {
      const r = await evaluate(`(async () => {
        const S = window.SF, pid = S.currentProjectId;
        const co = await S.db.insert('change_orders', { project_id: pid, co_number: 'CO-VERIFY-1', description: 'Additional containment', amount: 4500, status: 'pending' });
        await window.reloadProjectTable('change_orders', 'created_at', false);
        await window.approveItem('change_orders', co.id);
        await new Promise((res) => setTimeout(res, 300));
        const boqRows = await S.db.select('boq_items', { project_id: pid, code: 'CO-VERIFY-1' });
        return { count: boqRows.length, section: boqRows[0] && boqRows[0].section, rate: boqRows[0] && Number(boqRows[0].rate), status: boqRows[0] && boqRows[0].status };
      })()`);
      assertEqual(r.count, 1, 'exactly one variation line');
      assertEqual(r.section, 'Variations / Change Orders', 'section');
      assertEqual(r.rate, 4500, 'variation rate = CO amount');
      assertEqual(r.status, 'approved', 'variation is certified');
    });

    // ------------------------------------------- worker-linked timesheets + payroll run
    await check('payroll run: basic + 1.5x OT - loan, loan balance updated, expense posted', async () => {
      const r = await evaluate(`(async () => {
        const S = window.SF, pid = S.currentProjectId;
        const w = await S.db.insert('workers', { staff_no: 'EMP-V1', name: 'Verify Worker', trade: 'CONC', status: 'active', notes: '<!--sfpay:{"salary":1000,"loan":500,"deduct":200}-->\\n' });
        await window.loadCompanyData();
        const ts = await S.db.insert('timesheets', { project_id: pid, worker_id: w.id, employee_name: 'Verify Worker', trade: 'CONC', work_date: S.helpers.today(), reg_hours: 8, ot_hours: 2, total_hours: 10, rate_aed: 50, total_cost_aed: 550, status: 'approved' });
        await window.reloadProjectTable('timesheets', 'created_at', false);
        const beforeBatches = (await S.db.select('payroll_batches', { project_id: pid })).length;
        const beforeExpenses = (await S.db.select('company_expenses', null)).length;
        window.newPayrollBatch();
        const run = window._pendingPayrollRun;
        const line = run.lines.filter((l) => l.name === 'Verify Worker')[0];
        await window.commitUnifiedPayrollRun();
        await new Promise((res) => setTimeout(res, 400));
        const workerRows = await S.db.select('workers', { id: w.id });
        const afterBatches = (await S.db.select('payroll_batches', { project_id: pid })).length;
        const afterExpenses = (await S.db.select('company_expenses', null)).length;
        const m = String(workerRows[0].notes || '').match(/<!--sfpay:([\\s\\S]*?)-->/);
        const pay = m ? JSON.parse(m[1]) : {};
        return { otPay: line && line.otPay, gross: line && line.gross, deduct: line && line.deduct, net: line && line.net, loan: pay.loan, batches: afterBatches - beforeBatches, expenses: afterExpenses - beforeExpenses };
      })()`);
      assertEqual(r.otPay, 150, 'OT = 2 x 50 x 1.5');
      assertEqual(r.gross, 1150, 'gross = 1000 basic + 150 OT');
      assertEqual(r.deduct, 200, 'loan installment 200');
      assertEqual(r.net, 950, 'net pay');
      assertEqual(r.loan, 300, 'loan balance 500 -> 300');
      assertEqual(r.batches, 1, 'one certified payroll batch');
      assertEqual(r.expenses, 1, 'one salaries expense posted');
    });

    // ------------------------------------------------- BOQ valuation sheet -> IPC
    await check('BOQ valuation sheet sums line percentages and prefills the IPC', async () => {
      const r = await evaluate(`(async () => {
        window.openBoqValuationSheet();
        const inputs = document.querySelectorAll('.boq-val-pct');
        if (!inputs.length) throw new Error('no valuation inputs');
        inputs[0].value = '50';
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        const sum = window._lastBoqValSum;
        window.applyBoqValuationToIPC();
        await new Promise((res) => setTimeout(res, 200));
        const claim = document.getElementById('f_total_claim');
        return { sum, prefill: claim ? Number(claim.value) : null, lineTotal: Number(inputs[0].getAttribute('data-total')) };
      })()`);
      assert(r.sum > 0, 'valuation sum is positive');
      assertEqual(r.sum, Math.round(r.lineTotal * 0.5 * 100) / 100, 'sum = 50% of first line');
      assertEqual(r.prefill, r.sum, 'IPC gross valuation prefilled');
    });

    // ---------------------------------------------------- IPC -> receivables sync
    await check('certified IPC syncs into the receivables ledger (idempotent)', async () => {
      const r = await evaluate(`(async () => {
        const S = window.SF;
        const b = { billing_no: 'IPC-VERIFY-1', status: 'certified', total_payable_inc_vat: 1050 };
        await window.syncIPCToReceivables(b);
        await window.syncIPCToReceivables(b);
        const rows = await S.db.select('payments', { invoice_no: 'IPC-VERIFY-1' });
        return { count: rows.length, amount: rows[0] && Number(rows[0].amount), type: rows[0] && rows[0].payment_type, status: rows[0] && rows[0].status };
      })()`);
      assertEqual(r.count, 1, 'one receivable row after two syncs');
      assertEqual(r.amount, 1050, 'amount incl. VAT');
      assertEqual(r.type, 'pending', 'certified = outstanding receivable');
    });

    // ------------------------------------------------- alert dismissal + notifications
    await check('mark all read clears DB notifications and dismisses alerts', async () => {
      const r = await evaluate(`(async () => {
        const beforeAlerts = window.collectAlerts().length + window.collectBudgetAlerts().length;
        await window.markAllNotifsRead();
        await new Promise((res) => setTimeout(res, 200));
        const badge = document.getElementById('notifBadge');
        return {
          beforeAlerts,
          afterAlerts: window.collectAlerts().length + window.collectBudgetAlerts().length,
          unread: (window.SF.state.notifications || []).filter((n) => !n.is_read).length,
          dismissed: !!localStorage.getItem('sf_dismissed_alerts_v2'),
          badgeHidden: !badge || badge.style.display === 'none' || badge.textContent === '0'
        };
      })()`);
      assert(r.beforeAlerts > 0, 'fixture has active alerts to dismiss');
      assertEqual(r.afterAlerts, 0, 'all alerts filtered after dismissal');
      assertEqual(r.unread, 0, 'no unread notifications remain');
      assert(r.dismissed, 'dismissal persisted in localStorage');
      assert(r.badgeHidden, 'badge cleared');
    });

    // --------------------------------------------- cross-project executive approvals
    await check('company-level approvals queue aggregates pending work across projects', async () => {
      const r = await evaluate(`(async () => {
        await window.switchProject('');
        await window.loadCrossProjectPending();
        await new Promise((res) => setTimeout(res, 400));
        const items = window.__sf.collectPendingItems('all');
        const codes = {};
        items.forEach((i) => { codes[i.project] = (codes[i.project] || 0) + 1; });
        return { count: items.length, codes: Object.keys(codes), hasProjectCodes: Object.keys(codes).every((k) => k && k !== '—') };
      })()`);
      assert(r.count > 0, 'queue is not empty at company level');
      assert(r.hasProjectCodes, 'each item carries its project code: ' + JSON.stringify(r.codes));
    });
  });

  // --------------------------------------------------------------- static invariants
  await check('photo pipeline compresses to WebP and uploads with the right content type', async () => {
    assert(appSource.includes("var mime='image/webp'"), 'WebP encoding missing');
    assert(appSource.includes("contentType:p.mime||'image/webp'"), 'upload content type missing');
    assert(appSource.includes("createSignedUrl(p.path"), 'signed URL resolution missing');
  });
  await check('compatibility surface + new flows are wired', async () => {
    for (const needle of ['window.SiteForge=', 'window.state=state;', 'window.getBoqCommittedMap=', 'window.convertPOToBill=',
      'window.commitUnifiedPayrollRun=', 'window.openBoqValuationSheet=', 'window.syncIPCToReceivables=',
      'loadCrossProjectPending', 'dismissSingleAlert']) {
      assert(appSource.includes(needle), 'missing: ' + needle);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} upgrade checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => { console.error('Upgrade checks failed to run:', error); process.exit(1); });
