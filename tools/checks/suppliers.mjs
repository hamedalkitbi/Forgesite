// Verification for the Suppliers & Contractors module (company-level directory).
//
// Usage: node tools/checks/suppliers.mjs
//
// 1. Static checks (always run):
//    - node --check on scripts/modules/suppliers.js
//    - view-registration + public-API greps
//    - SQL-idempotency greps of supabase/migrations/202611050001_phase1_accountability.sql
//      for suppliers / project_suppliers (skipped with a note if the migration is not on disk).
// 2. Testkit checks (only once tools/lib/mock-supabase.mjs mirrors the suppliers tables):
//    boots the real app headless and asserts view render, lookup/active/list, and
//    idempotent project linking via linkToProject / unlink.
//    If the mock lacks suppliers, this step prints "skipped (mock not ready)" and exits 0.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { withApp, assert, assertEqual, ROOT } from '../lib/testkit.mjs';

const MODULE = join(ROOT, 'scripts', 'modules', 'suppliers.js');
const DOC = join(ROOT, 'docs', 'modules', 'suppliers.md');
const MOCK = join(ROOT, 'tools', 'lib', 'mock-supabase.mjs');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '202611050001_phase1_accountability.sql');

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
    if (r.status !== 0) {
      throw new Error((r.stderr || r.stdout || 'parse failed').trim());
    }
  });

  const src = readFileSync(MODULE, 'utf8');
  check('registers the suppliers view (company nav, director/controller)', () => {
    assert(src.includes('registerView({'), 'registerView({ missing');
    assert(src.includes("id: MODULE_ID") || src.includes("id: 'suppliers'"), 'view id missing');
    assert(src.includes("section: 'company'"), 'nav.section must be "company"');
    assert(src.includes("roles: ['director', 'controller']"), 'roles must be director/controller');
    assert(src.includes("label: 'Suppliers & Contractors'"), 'EN label missing');
    assert(src.includes("labelAr: 'الموردون والمقاولون'"), 'AR label missing');
    assert(src.includes("icon: '🏢'"), 'icon missing');
  });

  check('exposes window.SF_modules.suppliers API', () => {
    assert(src.includes('window.SF_modules'), 'SF_modules bucket missing');
    for (const key of ['list', 'lookup', 'linkToProject', 'unlink', 'active']) {
      assert(src.includes(key + ':'), `API key "${key}" missing`);
    }
  });

  check('loads suppliers via selectStrict with company_id filter', () => {
    assert(src.includes('selectStrict(TABLE'), 'selectStrict(TABLE) missing');
    assert(src.includes('company_id'), 'company_id filter missing');
  });

  check('project linking uses client().from(project_suppliers) with composite onConflict', () => {
    assert(src.includes('LINK_TABLE') || src.includes('project_suppliers'), 'project_suppliers reference missing');
    assert(src.includes('onConflict'), 'upsert onConflict missing');
    assert(src.includes("'project_id,supplier_id'"), 'composite conflict target missing');
    assert(src.includes('.delete()'), 'link delete missing');
  });

  check('docs/modules/suppliers.md exists', () => {
    assert(existsSync(DOC), 'docs/modules/suppliers.md missing');
  });

  if (!existsSync(MIGRATION)) {
    console.log('  ⏭ migration idempotency checks skipped (phase-1 migration not on disk yet)');
  } else {
    const mig = readFileSync(MIGRATION, 'utf8');
    check('migration creates suppliers idempotently', () => {
      assert(/create\s+table\s+if\s+not\s+exists\s+(public\.)?suppliers\b/i.test(mig), 'suppliers create-table-if-not-exists missing');
    });
    check('migration creates project_suppliers idempotently', () => {
      assert(/create\s+table\s+if\s+not\s+exists\s+(public\.)?project_suppliers\b/i.test(mig), 'project_suppliers create-table-if-not-exists missing');
    });
    check('project_suppliers has composite PK and cascade', () => {
      assert(/primary\s+key\s*\(\s*project_id\s*,\s*supplier_id\s*\)/i.test(mig), 'composite PK (project_id, supplier_id) missing');
      assert(mig.includes('on delete cascade'), 'on delete cascade missing');
    });
  }
}

async function testkitChecks() {
  const SUPPLIER_ID = 's0000000-0000-4000-8000-000000000001';

  await acheck('suppliers view renders in company context', async () => {
    await withApp({ role: 'director', project: null }, async ({ evaluate, goView, seedTable, diagnostics }) => {
      const ids = await evaluate(`(function(){var c=window.__MOCK_DB.companies[0];var p=window.__MOCK_DB.projects[0];return {company:c&&c.id,project:p&&p.id};})()`);
      await seedTable('suppliers', [{
        id: SUPPLIER_ID,
        company_id: ids.company,
        name: 'Verify Supplier LLC',
        kind: 'supplier',
        trade: 'CONC',
        trn: '100000000000003',
        contact_person: 'Omar Farooq',
        phone: '+971 4 000 0000',
        email: 'verify@example.com',
        status: 'active',
        payment_terms_days: 30,
        vat_pct: 5
      }]);
      diagnostics.clear();
      await goView('suppliers');
      const text = await evaluate('document.getElementById("main").textContent');
      assert(text.includes('Suppliers & Contractors'), 'title missing from #main');
      assert(text.includes('Verify Supplier LLC'), 'seeded supplier row missing');
      assert(diagnostics.errors.length === 0, diagnostics.errors.join(' | '));
    });
  });

  await acheck('supplier master lookup + active + list', async () => {
    await withApp({ role: 'director', project: null }, async ({ evaluate, goView, seedTable }) => {
      const ids = await evaluate(`(function(){var c=window.__MOCK_DB.companies[0];return c&&c.id;})()`);
      await seedTable('suppliers', [
        { id: SUPPLIER_ID, company_id: ids, name: 'Verify Supplier LLC', kind: 'supplier', status: 'active' },
        { id: 's0000000-0000-4000-8000-000000000002', company_id: ids, name: 'Dormant Supplier LLC', kind: 'both', status: 'inactive' }
      ]);
      await goView('suppliers');
      const r = await evaluate(`(function(){
        var m = window.SF_modules && window.SF_modules.suppliers;
        if (!m) return null;
        var hit = m.lookup('verify supplier llc');
        return {
          lookupName: hit && hit.name,
          lookupKind: hit && hit.kind,
          activeCount: m.active().length,
          listCount: m.list().length
        };
      })()`);
      assert(r, 'window.SF_modules.suppliers missing');
      assertEqual(r.lookupName, 'Verify Supplier LLC', 'lookup is case-insensitive');
      assertEqual(r.lookupKind, 'supplier', 'lookup returns the right row');
      assertEqual(r.activeCount, 1, 'active() filters to status active');
      assertEqual(r.listCount, 2, 'list() returns all cached rows');
    });
  });

  await acheck('linkToProject upserts idempotently and unlink removes', async () => {
    await withApp({ role: 'director', project: null }, async ({ evaluate, goView, seedTable }) => {
      const ids = await evaluate(`(function(){var c=window.__MOCK_DB.companies[0];var p=window.__MOCK_DB.projects[0];return {company:c&&c.id,project:p&&p.id};})()`);
      await seedTable('suppliers', [{ id: SUPPLIER_ID, company_id: ids.company, name: 'Verify Supplier LLC', kind: 'supplier', status: 'active' }]);
      await seedTable('project_suppliers', []);
      await goView('suppliers');
      // Drive linking through the public API (twice → idempotent), then unlink.
      const after = await evaluate(`(async function(){
        var m = window.SF_modules.suppliers;
        var client = window.SF.db.client();
        var projectId = window.__MOCK_DB.projects[0].id;
        var sid = ${JSON.stringify(SUPPLIER_ID)};
        await m.linkToProject(sid, projectId, { contract_amount_aed: 150000, reference: 'REF-1' });
        await m.linkToProject(sid, projectId, { contract_amount_aed: 160000, reference: 'REF-2' });
        var rows = await client.from('project_suppliers').select('*').eq('supplier_id', sid);
        var linkedCount = rows.data.length;
        var amount = rows.data[0] && Number(rows.data[0].contract_amount_aed);
        var reference = rows.data[0] && rows.data[0].reference;
        await m.unlink(projectId, sid);
        var afterRows = await client.from('project_suppliers').select('*').eq('supplier_id', sid);
        return { linkedCount: linkedCount, amount: amount, reference: reference, unlinkedCount: afterRows.data.length };
      })()`);
      assertEqual(after.linkedCount, 1, 'upsert must not duplicate rows');
      assertEqual(after.amount, 160000, 'upsert must merge the latest contract amount');
      assertEqual(after.reference, 'REF-2', 'upsert must merge the latest reference');
      assertEqual(after.unlinkedCount, 0, 'unlink must remove the link');
    });
  });
}

async function main() {
  console.log('\nSuppliers & Contractors — static checks');
  staticChecks();

  const mockSrc = readFileSync(MOCK, 'utf8');
  const mockReady = /\bsuppliers\b/.test(mockSrc) && /\bproject_suppliers\b/.test(mockSrc);

  if (!mockReady) {
    console.log('\nSuppliers & Contractors — testkit checks');
    console.log('  ⏭ skipped (mock not ready: tools/lib/mock-supabase.mjs has no suppliers / project_suppliers fixtures)');
  } else {
    console.log('\nSuppliers & Contractors — testkit checks');
    await testkitChecks();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} suppliers checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.error && f.error.message}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('Suppliers checks failed to run:', error);
  process.exit(1);
});
