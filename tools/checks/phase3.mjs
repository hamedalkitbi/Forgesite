// Phase 3 verification — mirrors supabase/migrations/202611050003_phase3.sql
// against the shared mock Supabase (tools/lib/mock-supabase.mjs).
//
//   node tools/checks/phase3.mjs
//
// Layers:
//   1. Static  — the migration is idempotent (create table if not exists,
//                create or replace function) and enables RLS.
//   2. Mock RPC — sf_retention_open returns {total_retained, released, open}
//                computed from progress_billings (certified/paid) minus
//                retention_releases.
//   3. Fixtures — retention_releases + subcontractor_certificates are seeded;
//                the management exception metrics (overdue approvals, unlinked
//                material cost, duplicate supplier invoices, committed-not-
//                delivered POs, open retention) are correct on the fixtures.
//   4. Data layer — certificate measurement (certified = qty × rate) and the
//                generate-payment-request link (payment_requests id) round-trip.
//   5. App     — SF.retention (app.js) and finance retentionPayable are asserted
//                when wired; SF_modules.retention / .subcertificates / .management
//                are reported skipped-pending until modules3 lands them (never a
//                false pass).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withApp, assert, assertEqual, ROOT } from '../lib/testkit.mjs';

const MIGRATION = join(ROOT, 'supabase', 'migrations', '202611050003_phase3.sql');

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
  console.log('Phase 3 — retention release / subcontractor certificates / management exceptions\n');

  /* ------------------------------------------------------------ static: migration */
  let migrationSql = '';
  try { migrationSql = await readFile(MIGRATION, 'utf8'); } catch { migrationSql = ''; }
  if (migrationSql) {
    await check('migration 202611050003 idempotent + enables RLS', async () => {
      const code = stripSqlComments(migrationSql);
      for (const table of ['retention_releases', 'subcontractor_certificates']) {
        assert(new RegExp(`create table if not exists public\\.${table}\\b`, 'i').test(code), `create table if not exists public.${table} missing`);
        assert(new RegExp(`alter table public\\.${table} enable row level security`, 'i').test(code), `alter table public.${table} enable row level security missing`);
      }
      assert(/create or replace function public\.sf_retention_open\b/i.test(code), 'create or replace function public.sf_retention_open missing');
      assert(/enable row level security/i.test(code), 'enable row level security missing');
      assert(/notify pgrst/i.test(code), 'notify pgrst (reload schema) missing');
    });
  } else {
    skipPending('migration 202611050003 idempotent + enables RLS', 'migration not present yet (db3 pending)');
  }

  /* ------------------------------------------------------------ mock + fixtures */
  let surface = null;
  await withApp({ role: 'director', project: 'PRJ-001' }, async ({ evaluate, diagnostics, projectId }) => {
    diagnostics.clear();

    surface = await evaluate(`(function () {
      return {
        retention: !!(window.SF && window.SF.retention && typeof window.SF.retention.open === 'function'),
        retentionModule: !!(window.SF_modules && window.SF_modules.retention && typeof window.SF_modules.retention.release === 'function'),
        subcertificatesModule: !!(window.SF_modules && window.SF_modules.subcertificates),
        managementModule: !!(window.SF_modules && window.SF_modules.management),
        finance: !!(window.SF_modules && window.SF_modules.finance && typeof window.SF_modules.finance.balanceSheet === 'function')
      };
    })()`);

    await check('phase 3 tables seeded', async () => {
      const r = await evaluate(`(function () {
        var db = window.__MOCK_DB;
        function has(t) { return !!db[t] && Array.isArray(db[t]); }
        return {
          retention: has('retention_releases'),
          certs: has('subcontractor_certificates'),
          retentionCount: (db.retention_releases || []).length,
          certCount: (db.subcontractor_certificates || []).length
        };
      })()`);
      assert(r.retention && r.certs, 'retention_releases + subcontractor_certificates must be seeded');
      assertEqual(r.retentionCount, 2, 'two retention releases seeded');
      assertEqual(r.certCount, 3, 'three subcontractor certificates seeded');
    });

    /* Retention position: total_retained (certified+paid) − releases. */
    await check('sf_retention_open: retained / released / open math', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var a = window.__MOCK_DB.projects[0].id;
        var b = window.__MOCK_DB.projects[1].id;
        var ra = await client.rpc('sf_retention_open', { p_project: a });
        var rb = await client.rpc('sf_retention_open', { p_project: b });
        return { a: ra.data, aError: ra.error, b: rb.data, bError: rb.error };
      })()`);
      assertEqual(r.aError, null, 'sf_retention_open must not error for project A');
      assertEqual(r.a.total_retained, 775000, 'project A total_retained (310000 certified + 465000 paid)');
      assertEqual(r.a.released, 225000, 'project A released (150000 + 75000)');
      assertEqual(r.a.open, 550000, 'project A open = 775000 − 225000');
      assertEqual(r.bError, null, 'sf_retention_open must not error for project B');
      assertEqual(r.b.total_retained, 0, 'project B has no certified/paid billings');
      assertEqual(r.b.released, 0, 'project B has no releases');
      assertEqual(r.b.open, 0, 'project B open is 0');
    });

    await check('retention: open = retained − released recomputes after a release', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var a = window.__MOCK_DB.projects[0].id;
        await client.from('retention_releases').insert({ project_id: a, amount_aed: 10000, release_date: '2026-11-01', released_by: 'Hamed Al Kitbi', reason: 'probe' });
        var after = await client.rpc('sf_retention_open', { p_project: a });
        await client.from('retention_releases').delete().eq('project_id', a).eq('amount_aed', 10000);
        var restored = await client.rpc('sf_retention_open', { p_project: a });
        return {
          released: after.data.released,
          open: after.data.open,
          restoredReleased: restored.data.released,
          restoredOpen: restored.data.open
        };
      })()`);
      assertEqual(r.released, 235000, 'released sums the probe release');
      assertEqual(r.open, 540000, 'open decreases by the release amount');
      assertEqual(r.restoredReleased, 225000, 'cleanup restores released');
      assertEqual(r.restoredOpen, 550000, 'cleanup restores open');
    });

    /* Certificate measurement: certified_amount_aed = measured_qty × rate_aed. */
    await check('subcontractor certificates: certified = measured_qty × rate_aed', async () => {
      const r = await evaluate(`(function () {
        var certs = window.__MOCK_DB.subcontractor_certificates || [];
        var bad = [];
        certs.forEach(function (c) {
          var expected = Math.round(Number(c.measured_qty || 0) * Number(c.rate_aed || 0) * 100) / 100;
          if (Number(c.certified_amount_aed) !== expected) bad.push(c.reference + ':' + c.certified_amount_aed + '!=' + expected);
        });
        return { count: certs.length, bad: bad, first: certs[0] };
      })()`);
      assertEqual(r.count, 3, 'three certificates seeded');
      assertEqual(r.bad.length, 0, 'every seeded certificate satisfies certified = qty × rate: ' + r.bad.join(', '));
      assertEqual(Number(r.first.certified_amount_aed), 500000, 'SC-0001 = 0.4 × 1,250,000');
    });

    await check('certificate + generate-payment-request links a submitted payment_requests row', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var a = window.__MOCK_DB.projects[0].id;
        var supplier = window.__MOCK_DB.subcontractor_certificates[0].supplier_id;
        var ins = await client.from('subcontractor_certificates').insert({ project_id: a, supplier_id: supplier, boq_item_id: 'probe', reference: 'SC-PROBE', period: '2026-11', measured_qty: 0.5, rate_aed: 200000, certified_amount_aed: 100000, status: 'draft' });
        var cert = ins.data[0];
        var certified = Math.round(Number(cert.measured_qty) * Number(cert.rate_aed) * 100) / 100;
        var pr = await client.from('payment_requests').insert({ project_id: a, party_id: supplier, request_type: 'subcontractor', reference: 'PR-PROBE', description: 'Generated from SC-PROBE', amount_aed: certified, retention_pct: 0, retention_aed: 0, advance_recovery_aed: 0, net_aed: certified, status: 'submitted', requested_by: 'Sanjay Menon' });
        var prId = pr.data[0].id;
        await client.from('subcontractor_certificates').update({ payment_request_id: prId }).eq('id', cert.id);
        var linked = await client.from('subcontractor_certificates').select('*').eq('id', cert.id);
        var linkedPr = await client.from('payment_requests').select('*').eq('id', prId);
        await client.from('subcontractor_certificates').delete().eq('id', cert.id);
        await client.from('payment_requests').delete().eq('id', prId);
        return {
          certified: certified,
          certCertified: Number(linked.data[0].certified_amount_aed),
          prCount: linkedPr.data.length,
          prType: linkedPr.data[0] && linkedPr.data[0].request_type,
          prStatus: linkedPr.data[0] && linkedPr.data[0].status,
          prNet: linkedPr.data[0] && Number(linkedPr.data[0].net_aed),
          linkedId: linked.data[0].payment_request_id === prId
        };
      })()`);
      assertEqual(r.certified, 100000, 'measured certified = 0.5 × 200000');
      assertEqual(r.certCertified, 100000, 'certificate stores the measured amount');
      assertEqual(r.prCount, 1, 'generate-payment-request creates one payment_requests row');
      assertEqual(r.prType, 'subcontractor', 'generated request is request_type subcontractor');
      assertEqual(r.prStatus, 'submitted', 'generated request status is submitted');
      assertEqual(r.prNet, 100000, 'generated request net_aed = certified amount');
      assert(r.linkedId, 'certificate.payment_request_id links the generated payment_requests id');
    });

    /* Management exception metrics — computed from the seeded fixtures. */
    await check('management: overdue submitted payment requests (Overdue KPI)', async () => {
      const r = await evaluate(`(function () {
        var today = window.SF.helpers.today();
        var rows = (window.__MOCK_DB.payment_requests || []).filter(function (p) {
          return p.status === 'submitted' && p.due_date && p.due_date < today;
        });
        var value = rows.reduce(function (s, p) { return s + (Number(p.net_aed) || 0); }, 0);
        return { count: rows.length, value: Math.round(value * 100) / 100 };
      })()`);
      assertEqual(r.count, 1, 'overdue count (submitted + past due)');
      assertEqual(r.value, 175750, 'overdue value (net_aed)');
    });

    await check('management: unlinked material cost', async () => {
      const r = await evaluate(`(function () {
        var rows = (window.__MOCK_DB.materials || []).filter(function (m) {
          return m.boq_item_id === null || m.boq_item_id === undefined || m.boq_item_id === '';
        });
        var cost = rows.reduce(function (s, m) { return s + (Number(m.quantity) || 0) * (Number(m.unit_cost_aed) || 0); }, 0);
        return { count: rows.length, cost: Math.round(cost * 100) / 100 };
      })()`);
      assertEqual(r.count, 1, 'unlinked materials count');
      assertEqual(r.cost, 18500, 'unlinked material cost (1 × 18500)');
    });

    await check('management: duplicate supplier invoice_no detected', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var a = window.__MOCK_DB.projects[0].id;
        function duplicates() {
          var rows = (window.__MOCK_DB.payments || []).filter(function (p) { return p.invoice_no && String(p.invoice_no).trim(); });
          var seen = {}, dup = [];
          rows.forEach(function (p) {
            var k = String(p.invoice_no).trim();
            (seen[k] = seen[k] || []).push(p.id);
          });
          Object.keys(seen).forEach(function (k) { if (seen[k].length > 1) dup.push({ invoice_no: k, count: seen[k].length }); });
          return dup;
        }
        var baseline = duplicates();
        var ins = await client.from('payments').insert({ project_id: a, payment_type: 'invoice', invoice_no: 'SUP-3311', description: 'Duplicate supplier invoice probe', amount: 96500, status: 'pending' });
        var probeId = ins.data[0].id;
        var afterInsert = duplicates();
        await client.from('payments').delete().eq('id', probeId);
        var afterCleanup = duplicates();
        return { baseline: baseline, afterInsert: afterInsert, afterCleanup: afterCleanup };
      })()`);
      assertEqual(r.baseline.length, 0, 'seed has no duplicate supplier invoice_no');
      assertEqual(r.afterInsert.length, 1, 'duplicate invoice_no detected after inserting a duplicate');
      assertEqual(r.afterInsert[0].invoice_no, 'SUP-3311', 'the duplicate is SUP-3311');
      assertEqual(r.afterInsert[0].count, 2, 'SUP-3311 appears twice');
      assertEqual(r.afterCleanup.length, 0, 'cleanup restores no-duplicate state');
    });

    await check('management: committed-but-undelivered POs', async () => {
      const r = await evaluate(`(function () {
        var rows = (window.__MOCK_DB.materials || []).filter(function (m) {
          return m.stage === 'Ordered' || m.stage === 'In Transit';
        });
        var value = rows.reduce(function (s, m) { return s + (Number(m.quantity) || 0) * (Number(m.unit_cost_aed) || 0); }, 0);
        return { count: rows.length, value: Math.round(value * 100) / 100 };
      })()`);
      assertEqual(r.count, 2, 'committed-not-delivered PO count (Ordered/In Transit)');
      assertEqual(r.value, 280800, 'committed-not-delivered value (240000 + 40800)');
    });

    await check('management: open retention total across projects', async () => {
      const r = await evaluate(`(async function () {
        var client = window.SF.db.client();
        var projects = window.__MOCK_DB.projects || [];
        var total = 0;
        for (var i = 0; i < projects.length; i += 1) {
          var res = await client.rpc('sf_retention_open', { p_project: projects[i].id });
          total += Number(res.data && res.data.open) || 0;
        }
        return { total: Math.round(total * 100) / 100 };
      })()`);
      assertEqual(r.total, 550000, 'open retention total across projects (550000 + 0)');
    });

    /* App.js bridge — SF.retention is owned by the Lead; assert only if wired. */
    if (surface.retention) {
      await check('SF.retention released / releasedTotal / open (app.js)', async () => {
        const r = await evaluate(`(async function () {
          var a = window.__MOCK_DB.projects[0].id;
          await window.SF.retention.refresh();
          var total = await window.SF.retention.releasedTotal();
          var rel = await window.SF.retention.released(a);
          var open = await window.SF.retention.open(a);
          return { cached: window.SF.retention._releasedTotal, total: total, rel: rel, open: open };
        })()`);
        assertEqual(r.cached, 225000, 'SF.retention.refresh() sets _releasedTotal');
        assertEqual(r.total, 225000, 'SF.retention.releasedTotal() = 225000');
        assertEqual(r.rel, 225000, 'SF.retention.released(projectA) = 225000');
        assertEqual(r.open, 550000, 'SF.retention.open(projectA) = 775000 − 225000');
      });
    } else {
      skipPending('SF.retention released / releasedTotal / open (app.js)', 'SF.retention not wired in app.js yet (Lead pending) — retention RPC math verified instead');
    }

    if (surface.finance) {
      await check('finance: retentionPayable subtracts released retention', async () => {
        const r = await evaluate(`(async function () {
          var fin = window.SF_modules.finance;
          var billings = (window.__MOCK_DB.progress_billings || []).filter(function (b) { return b.status === 'certified' || b.status === 'paid'; });
          var gross = billings.reduce(function (s, b) { return s + (Number(b.retention_amount) || 0); }, 0);
          var empty = { billings: billings, payments: [], materials: [], timesheets: [], expenses: [], paymentRequests: [], projects: [], companies: [], settings: [], retentionReleases: [{ amount_aed: 150000 }] };
          var defaulted = fin.balanceSheet(empty, {});
          var with225 = fin.balanceSheet(empty, { releasedRetention: 225000 });
          return {
            gross: Math.round(gross * 100) / 100,
            defaulted: defaulted.retentionPayable,
            with225: with225.retentionPayable
          };
        })()`);
        assertEqual(r.gross, 775000, 'gross retained from fixtures');
        assertEqual(r.defaulted, 625000, 'retentionPayable subtracts the 150000 release in the data');
        assertEqual(r.with225, 550000, 'retentionPayable subtracts an explicit 225000 release');
      });
    } else {
      skipPending('finance: retentionPayable subtracts released retention', 'SF_modules.finance not wired yet — retention math verified instead');
    }

    /* modules3 — retention / subcertificates / management modules. */
    if (surface.retentionModule) {
      await check('retention module: release ≤ open enforced', async () => {
        const r = await evaluate(`(async function () {
          var m = window.SF_modules.retention;
          var over = await m.release(999999, 'over open probe');
          return { overOk: over.ok, hasError: !!(over.error) };
        })()`);
        assertEqual(r.overOk, false, 'releasing more than open must be refused');
        assert(r.hasError, 'over-open release returns an error');
      });
    } else {
      skipPending('retention module: release ≤ open enforced', 'SF_modules.retention not wired yet (modules3 pending) — sf_retention_open math verified instead');
    }

    if (surface.subcertificatesModule) {
      await check('subcertificates module: compute + generate-payment-request surface', async () => {
        const r = await evaluate(`(function () {
          var m = window.SF_modules.subcertificates;
          return {
            compute: typeof m.compute === 'function',
            certify: typeof m.certify === 'function',
            generatePaymentRequest: typeof m.generatePaymentRequest === 'function',
            measured: m.compute(0.5, 200000)
          };
        })()`);
        assert(r.compute && r.certify && r.generatePaymentRequest, 'SF_modules.subcertificates methods missing');
        assertEqual(r.measured, 100000, 'SF_modules.subcertificates.compute(0.5, 200000) = 100000');
      });
    } else {
      skipPending('subcertificates module: compute + generate-payment-request surface', 'SF_modules.subcertificates not wired yet (modules3 pending) — data-layer round-trip verified instead');
    }

    if (surface.managementModule) {
      await check('management module: metric functions correct on fixtures', async () => {
        const r = await evaluate(`(function () {
          var m = window.SF_modules.management;
          var materials = (window.__MOCK_DB.materials || []).map(function (x) {
            return { boq_item_id: x.boq_item_id, qty: Number(x.quantity) || 0, unitCost: Number(x.unit_cost_aed) || 0, stage: x.stage };
          });
          var payments = (window.__MOCK_DB.payments || []).map(function (x) {
            return { invoiceNo: x.invoice_no, amount: Number(x.amount) || 0 };
          });
          var billings = (window.__MOCK_DB.progress_billings || []).map(function (x) {
            return { project_id: x.project_id, status: x.status, retentionAmount: Number(x.retention_amount) || 0 };
          });
          var releases = window.__MOCK_DB.retention_releases || [];
          var unlinked = m.unlinkedMaterialCost(materials);
          var committed = m.committedUndeliveredPos(materials);
          var dup = m.duplicateSupplierInvoices(payments);
          var retention = m.openRetentionTotal(billings, releases);
          var old = new Date(Date.now() - 10 * 86400000).toISOString();
          var fresh = new Date(Date.now() - 1 * 86400000).toISOString();
          var overdue = m.overdueApprovals([
            { type: 'PO', label: 'old', amount: 100, createdAt: old },
            { type: 'PO', label: 'fresh', amount: 200, createdAt: fresh }
          ], 3);
          return {
            unlinkedCount: unlinked.count, unlinkedValue: unlinked.value,
            committedCount: committed.count, committedValue: committed.value,
            dupCount: dup.count,
            retained: retention.totalRetained, released: retention.released, open: retention.open,
            overdueCount: overdue.count, overdueValue: overdue.value
          };
        })()`);
        assertEqual(r.unlinkedCount, 1, 'management.unlinkedMaterialCost count');
        assertEqual(r.unlinkedValue, 18500, 'management.unlinkedMaterialCost value');
        assertEqual(r.committedCount, 2, 'management.committedUndeliveredPos count');
        assertEqual(r.committedValue, 280800, 'management.committedUndeliveredPos value');
        assertEqual(r.dupCount, 0, 'management.duplicateSupplierInvoices count (seed clean)');
        assertEqual(r.retained, 775000, 'management.openRetentionTotal totalRetained');
        assertEqual(r.released, 225000, 'management.openRetentionTotal released');
        assertEqual(r.open, 550000, 'management.openRetentionTotal open');
        assertEqual(r.overdueCount, 1, 'management.overdueApprovals flags only the >sla item');
        assertEqual(r.overdueValue, 100, 'management.overdueApprovals sums the overdue amount');
      });
    } else {
      skipPending('management module: metric functions correct on fixtures', 'SF_modules.management not wired yet (modules3 pending) — fixture metrics verified directly');
    }

    await check('no JS exceptions during phase 3 checks', async () => {
      assertEqual((diagnostics.errors || []).length, 0, 'JS exceptions: ' + (diagnostics.errors || []).join(' | '));
    });
  });

  /* --------------------------------------------------------------- summary */
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  console.log(`\nPhase 3: ${passed} passed, ${skippedCount} skipped-pending, ${failed.length} failed (of ${results.length} checks)`);
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\n✗ phase3 checks crashed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
