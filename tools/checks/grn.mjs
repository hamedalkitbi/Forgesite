// Verification for the Receiving / GRN module (project-scoped Goods Received Notes).
//
// Usage: node tools/checks/grn.mjs
//
// 1. Static checks (always run):
//    - node --check on scripts/modules/grn.js
//    - view-registration + public-API greps
//    - SQL-idempotency greps of supabase/migrations/202611050002_phase2_workflow.sql
//      for goods_received_notes (skipped with a note if the migration is not on disk).
// 2. Testkit checks (only once tools/lib/mock-supabase.mjs mirrors the goods_received_notes
//    table): boots the real app headless and asserts view render, receivedQty/matched math,
//    and add/remove with an auto GRN-#### reference.
//    If the mock lacks goods_received_notes, this step prints "skipped-pending" and exits 0.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { withApp, assert, assertEqual, ROOT } from '../lib/testkit.mjs';

const MODULE = join(ROOT, 'scripts', 'modules', 'grn.js');
const DOC = join(ROOT, 'docs', 'modules', 'grn.md');
const MOCK = join(ROOT, 'tools', 'lib', 'mock-supabase.mjs');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '202611050002_phase2_workflow.sql');

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
  check('registers the grn view (project nav, director/controller/super)', () => {
    assert(src.includes('registerView({'), 'registerView({ missing');
    assert(src.includes("id: MODULE_ID") || src.includes("id: 'grn'"), 'view id missing');
    assert(src.includes("section: 'project'"), 'nav.section must be "project"');
    assert(src.includes("roles: ['director', 'controller', 'super']"), 'roles must be director/controller/super');
    assert(src.includes("label: 'Receiving / GRN'"), 'EN label missing');
    assert(src.includes("labelAr: 'استلام البضاعة'"), 'AR label missing');
    assert(src.includes("icon: '📦'"), 'icon missing');
  });

  check('exposes window.SF_modules.grn API', () => {
    assert(src.includes('window.SF_modules'), 'SF_modules bucket missing');
    for (const key of ['list', 'receivedQty', 'matched', 'add', 'remove']) {
      assert(src.includes(key + ':'), `API key "${key}" missing`);
    }
  });

  check('loads via selectStrict with project_id filter + received_date order', () => {
    assert(src.includes('selectStrict(TABLE'), 'selectStrict(TABLE) missing');
    assert(src.includes('project_id'), 'project_id filter missing');
    assert(src.includes("'received_date'"), 'received_date order missing');
  });

  check('auto reference GRN-#### (next number per project)', () => {
    assert(src.includes("'GRN-'"), 'GRN- prefix missing');
    assert(src.includes('padStart'), 'zero-padding (padStart) missing');
    assert(src.includes('nextReference'), 'nextReference helper missing');
  });

  check('docs/modules/grn.md exists', () => {
    assert(existsSync(DOC), 'docs/modules/grn.md missing');
  });

  if (!existsSync(MIGRATION)) {
    console.log('  ⏭ migration idempotency checks skipped (phase-2 migration not on disk yet)');
  } else {
    const mig = readFileSync(MIGRATION, 'utf8');
    check('migration creates goods_received_notes idempotently', () => {
      assert(/create\s+table\s+if\s+not\s+exists\s+(public\.)?goods_received_notes\b/i.test(mig), 'goods_received_notes create-table-if-not-exists missing');
    });
    check('goods_received_notes has project_id cascade + reference + qty_received', () => {
      assert(mig.includes('goods_received_notes'), 'goods_received_notes reference missing');
      assert(/on\s+delete\s+cascade/i.test(mig), 'on delete cascade missing');
      assert(mig.includes('reference'), 'reference column missing');
      assert(mig.includes('qty_received'), 'qty_received column missing');
    });
  }
}

async function testkitChecks() {
  await acheck('grn view renders in project context', async () => {
    await withApp({ role: 'director', project: 0 }, async ({ evaluate, goView, seedTable, diagnostics }) => {
      const ids = await evaluate(`(function(){var p=window.__MOCK_DB.projects[0];var m=window.__MOCK_DB.materials[0];return {project:p&&p.id,mat:m&&m.id};})()`);
      await seedTable('goods_received_notes', [{
        id: 'g0000000-0000-4000-8000-000000000001',
        project_id: ids.project,
        material_id: ids.mat,
        supplier_id: null,
        reference: 'GRN-0001',
        received_date: '2026-10-01',
        qty_received: 100,
        received_by: 'Hamed Al Kitbi',
        notes: null,
        status: 'received'
      }]);
      diagnostics.clear();
      await goView('grn');
      const text = await evaluate('document.getElementById("main").textContent');
      assert(text.includes('Receiving / GRN'), 'title missing from #main');
      assert(text.includes('GRN-0001'), 'seeded reference missing');
      assert(diagnostics.errors.length === 0, diagnostics.errors.join(' | '));
    });
  });

  await acheck('receivedQty sums and matched flips at ordered qty; add/remove round-trip', async () => {
    await withApp({ role: 'director', project: 0 }, async ({ evaluate, goView, seedTable }) => {
      const ids = await evaluate(`(function(){var p=window.__MOCK_DB.projects[0];var m=window.__MOCK_DB.materials[0];return {project:p&&p.id,mat:m&&m.id};})()`);
      // materials[0] is "Ready-mix concrete C35/20", ordered quantity 320.
      await seedTable('goods_received_notes', [{
        id: 'g0000000-0000-4000-8000-000000000001',
        project_id: ids.project,
        material_id: ids.mat,
        reference: 'GRN-0001',
        received_date: '2026-10-01',
        qty_received: 100,
        received_by: 'Hamed Al Kitbi',
        status: 'received'
      }]);
      await goView('grn');

      const before = await evaluate(`(function(){
        var m = window.SF_modules && window.SF_modules.grn;
        if (!m) return null;
        var matId = window.__MOCK_DB.materials[0].id;
        return { receivedQty: m.receivedQty(matId), matched: m.matched(matId), listCount: m.list().length };
      })()`);
      assert(before, 'window.SF_modules.grn missing');
      assertEqual(before.receivedQty, 100, 'receivedQty reads the cached GRN');
      assertEqual(before.matched, false, 'matched false below ordered qty');
      assertEqual(before.listCount, 1, 'list() returns the cached row');

      const addRes = await evaluate(`(async function(){
        var m = window.SF_modules.grn;
        var matId = window.__MOCK_DB.materials[0].id;
        return await m.add(matId, 220, { received_date: '2026-10-02', received_by: 'Tester' });
      })()`);
      assert(addRes && !addRes.error, 'add() error: ' + (addRes && addRes.error && addRes.error.message));
      assertEqual(addRes.data.reference, 'GRN-0002', 'add() auto-generates the next reference');

      await goView('grn'); // reload cache (add() marks the module stale)
      const after = await evaluate(`(function(){
        var m = window.SF_modules.grn;
        var matId = window.__MOCK_DB.materials[0].id;
        return { receivedQty: m.receivedQty(matId), matched: m.matched(matId), listCount: m.list().length };
      })()`);
      assertEqual(after.receivedQty, 320, 'receivedQty includes the added row');
      assertEqual(after.matched, true, 'matched flips at >= ordered qty');
      assertEqual(after.listCount, 2, 'list() includes the added row');

      const removeRes = await evaluate(`(async function(){
        var m = window.SF_modules.grn;
        var rows = await window.SF.db.client().from('goods_received_notes').select('*');
        var added = rows.data.find(function(r){ return r.reference === 'GRN-0002'; });
        return await m.remove(added.id);
      })()`);
      assert(removeRes && !removeRes.error, 'remove() error: ' + (removeRes && removeRes.error && removeRes.error.message));
      const gone = await evaluate(`(async function(){
        var rows = await window.SF.db.client().from('goods_received_notes').select('*');
        return rows.data.filter(function(r){ return r.reference === 'GRN-0002'; }).length;
      })()`);
      assertEqual(gone, 0, 'remove() deletes the row');
    });
  });
}

async function main() {
  console.log('\nReceiving / GRN — static checks');
  staticChecks();

  const mockSrc = readFileSync(MOCK, 'utf8');
  const mockReady = /\bgoods_received_notes\b/.test(mockSrc);

  if (!mockReady) {
    console.log('\nReceiving / GRN — testkit checks');
    console.log('  ⏭ skipped-pending (mock not ready: tools/lib/mock-supabase.mjs has no goods_received_notes fixtures)');
  } else {
    console.log('\nReceiving / GRN — testkit checks');
    await testkitChecks();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} grn checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.error && f.error.message}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('grn checks failed to run:', error);
  process.exit(1);
});
