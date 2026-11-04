// Verification for the Management Exceptions module (company-level dashboard).
//
// Usage: node tools/checks/management.mjs
//
// 1. Static checks (always run):
//    - node --check on scripts/modules/management.js
//    - view-registration + public-API + cross-project selectStrict + retention greps
//    - SQL-idempotency greps of supabase/migrations/202611050003_phase3.sql for
//      retention_releases (skipped with a note if the migration is not on disk).
// 2. Testkit checks (the mock already seeds materials/payments/progress_billings):
//    boots the real app headless and asserts view render + the pure metric
//    functions against seeded fixtures and explicit inputs.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { withApp, assert, assertEqual, ROOT } from '../lib/testkit.mjs';

const MODULE = join(ROOT, 'scripts', 'modules', 'management.js');
const DOC = join(ROOT, 'docs', 'modules', 'management.md');
const MOCK = join(ROOT, 'tools', 'lib', 'mock-supabase.mjs');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '202611050003_phase3.sql');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name} — ${error.message}`);
  }
}
async function acheck(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name} — ${error.message}`);
  }
}

function staticChecks() {
  check('module parses (node --check)', () => {
    const r = spawnSync(process.execPath, ['--check', MODULE], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'parse failed').trim());
  });

  const src = readFileSync(MODULE, 'utf8');
  check('registers the management view (company nav, director/controller)', () => {
    assert(src.includes('registerView({'), 'registerView({ missing');
    assert(src.includes("id: MODULE_ID") || src.includes("id: 'management'"), 'view id missing');
    assert(src.includes("section: 'company'"), 'nav.section must be "company"');
    assert(src.includes("roles: ['director', 'controller']"), 'roles must be director/controller');
    assert(src.includes("label: 'Management Exceptions'"), 'EN label missing');
    assert(src.includes("labelAr: 'مؤشرات الإدارة'"), 'AR label missing');
    assert(src.includes("icon: '📊'"), 'icon missing');
  });

  check('exposes window.SF_modules.management API', () => {
    assert(src.includes('window.SF_modules'), 'SF_modules bucket missing');
    for (const key of ['unlinkedMaterialCost', 'duplicateSupplierInvoices', 'committedUndeliveredPos', 'openRetentionTotal', 'overdueApprovals']) {
      assert(src.includes(key + ':'), `API key "${key}" missing`);
    }
  });

  check('loads cross-project via selectStrict (no project filter)', () => {
    assert(src.includes('selectStrict'), 'selectStrict missing');
    assert(src.includes('null, null, false'), 'cross-project selectStrict(name, null, null, false) missing');
    assert(src.includes('progress_billings'), 'progress_billings reference missing');
    assert(src.includes('retention_releases'), 'retention_releases reference missing');
  });

  check('overdue approvals use collectPendingItems + daysSince + SLA', () => {
    assert(src.includes('collectPendingItems'), 'collectPendingItems missing');
    assert(src.includes('daysSince'), 'daysSince missing');
    assert(src.includes('slaDays'), 'SLA days handling missing');
  });

  check('exception metrics reference boq_item_id / invoice_no / Ordered / In Transit', () => {
    assert(src.includes('boq_item_id'), 'boq_item_id (unlinked materials) missing');
    assert(src.includes('invoiceNo'), 'invoiceNo (duplicate invoices) missing');
    assert(src.includes('Ordered'), 'Ordered stage missing');
    assert(src.includes('In Transit'), 'In Transit stage missing');
  });

  check('docs/modules/management.md exists', () => {
    assert(existsSync(DOC), 'docs/modules/management.md missing');
  });

  if (!existsSync(MIGRATION)) {
    console.log('  ⏭ migration idempotency checks skipped (phase-3 migration not on disk yet)');
  } else {
    const mig = readFileSync(MIGRATION, 'utf8');
    check('migration creates retention_releases idempotently', () => {
      assert(/create\s+table\s+if\s+not\s+exists\s+(public\.)?retention_releases\b/i.test(mig), 'retention_releases create-table-if-not-exists missing');
    });
  }
}

async function testkitChecks() {
  await acheck('management view renders in company context with zero exceptions', async () => {
    await withApp({ role: 'director', project: null }, async ({ evaluate, goView, diagnostics }) => {
      diagnostics.clear();
      await goView('management');
      const text = await evaluate('document.getElementById("main").textContent');
      assert(text.includes('Management Exceptions'), 'title missing from #main');
      assert(diagnostics.errors.length === 0, diagnostics.errors.join(' | '));
    });
  });

  await acheck('management metrics match seeded cross-project fixtures', async () => {
    await withApp({ role: 'director', project: null }, async ({ evaluate, goView, waitFor }) => {
      await goView('management');
      await waitFor(
        `(function(){var m=window.SF_modules&&window.SF_modules.management;if(!m)return false;var x=m.metrics();return !!(x&&x.retention&&x.retention.totalRetained===775000);})()`,
        { label: 'management metrics loaded (retention total 775000)', timeout: 10000 }
      );
      const r = await evaluate(`(function(){
        var m = window.SF_modules.management;
        var x = m.metrics();
        return {
          unlinkedCount: x.unlinked.count,
          unlinkedValue: x.unlinked.value,
          committedCount: x.committed.count,
          committedValue: x.committed.value,
          retained: x.retention.totalRetained,
          released: x.retention.released,
          open: x.retention.open
        };
      })()`);
      // Seeded fixtures: one unlinked material (Safety First 18,500), two committed
      // POs (Ordered 240,000 + In Transit 40,800), and PB-001 (310,000) + PB-002
      // (465,000) certified/paid retention with no releases.
      assertEqual(r.unlinkedCount, 1, 'unlinked material count');
      assertEqual(r.unlinkedValue, 18500, 'unlinked material value');
      assertEqual(r.committedCount, 2, 'committed undelivered PO count');
      assertEqual(r.committedValue, 280800, 'committed undelivered PO value');
      assertEqual(r.retained, 775000, 'total retained');
      assertEqual(r.released, 0, 'released (no retention_releases in mock)');
      assertEqual(r.open, 775000, 'open retention');
    });
  });

  await acheck('management pure functions compute correctly on explicit inputs', async () => {
    await withApp({ role: 'director', project: null }, async ({ evaluate, goView }) => {
      await goView('management');
      const r = await evaluate(`(function(){
        var m = window.SF_modules.management;
        var dup = m.duplicateSupplierInvoices([
          { invoiceNo: 'INV-1', amount: 100 },
          { invoiceNo: 'INV-1', amount: 50 },
          { invoiceNo: 'INV-2', amount: 200 }
        ]);
        var overdue = m.overdueApprovals([
          { createdAt: '2026-01-01', amount: 100, label: 'Old', type: 'BOQ' },
          { createdAt: '2026-11-01', amount: 50, label: 'Recent', type: 'PO' }
        ], 3, '2026-11-04');
        var retention = m.openRetentionTotal([
          { project_id: 'p1', status: 'certified', retentionAmount: 100 },
          { project_id: 'p1', status: 'paid', retentionAmount: 200 },
          { project_id: 'p1', status: 'draft', retentionAmount: 999 }
        ], [{ project_id: 'p1', amount_aed: 50 }]);
        return {
          dupCount: dup.count, dupValue: dup.value, dupRows: dup.rows[0] && dup.rows[0].count,
          overdueCount: overdue.count, overdueValue: overdue.value,
          retained: retention.totalRetained, released: retention.released, open: retention.open
        };
      })()`);
      assertEqual(r.dupCount, 1, 'one duplicate invoice number');
      assertEqual(r.dupValue, 150, 'duplicate invoice exposure (100 + 50)');
      assertEqual(r.dupRows, 2, 'duplicate invoice row count');
      assertEqual(r.overdueCount, 1, 'one overdue item older than SLA');
      assertEqual(r.overdueValue, 100, 'overdue exposure');
      assertEqual(r.retained, 300, 'retained = certified + paid only');
      assertEqual(r.released, 50, 'released sum');
      assertEqual(r.open, 250, 'open = 300 - 50');
    });
  });
}

async function main() {
  console.log('\nManagement Exceptions — static checks');
  staticChecks();

  const mockSrc = readFileSync(MOCK, 'utf8');
  const mockReady = /\bmaterials\b/.test(mockSrc) && /\bpayments\b/.test(mockSrc) && /\bprogress_billings\b/.test(mockSrc);

  if (!mockReady) {
    console.log('\nManagement Exceptions — testkit checks');
    console.log('  ⏭ skipped (mock not ready: tools/lib/mock-supabase.mjs has no materials/payments/progress_billings fixtures)');
  } else {
    console.log('\nManagement Exceptions — testkit checks');
    await testkitChecks();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} management checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.error && f.error.message}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('Management checks failed to run:', error);
  process.exit(1);
});
