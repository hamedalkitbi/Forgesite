// Verification for the Subcontractor Measurement & Certificates module.
//
// Usage: node tools/checks/subcertificates.mjs
//
// 1. Static checks (always run):
//    - node --check on scripts/modules/subcertificates.js
//    - view-registration + public-API + selectStrict/insert + payment-request wiring greps
//    - SQL-idempotency greps of supabase/migrations/202611050003_phase3.sql for
//      subcontractor_certificates (skipped with a note if the migration is not on disk).
// 2. Testkit checks (once tools/lib/mock-supabase.mjs mirrors subcontractor_certificates):
//    boots the real app headless and asserts render + qty*rate math + certify +
//    generate-payment-request linking. If the mock lacks the table, the testkit
//    step prints "skipped (mock not ready)".

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { withApp, assert, assertEqual, ROOT } from '../lib/testkit.mjs';

const MODULE = join(ROOT, 'scripts', 'modules', 'subcertificates.js');
const DOC = join(ROOT, 'docs', 'modules', 'subcertificates.md');
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
  check('registers the subcertificates view (project nav, director/controller)', () => {
    assert(src.includes('registerView({'), 'registerView({ missing');
    assert(src.includes("id: MODULE_ID") || src.includes("id: 'subcertificates'"), 'view id missing');
    assert(src.includes("section: 'project'"), 'nav.section must be "project"');
    assert(src.includes("roles: ['director', 'controller']"), 'roles must be director/controller');
    assert(src.includes("label: 'Measurement & Certificates'"), 'EN label missing');
    assert(src.includes("labelAr: 'شهادات المقاولين'"), 'AR label missing');
    assert(src.includes("icon: '📏'"), 'icon missing');
  });

  check('exposes window.SF_modules.subcertificates API', () => {
    assert(src.includes('window.SF_modules'), 'SF_modules bucket missing');
    for (const key of ['list', 'compute', 'nextReference', 'create', 'certify', 'generatePaymentRequest']) {
      assert(src.includes(key + ':'), `API key "${key}" missing`);
    }
  });

  check('loads certificates via selectStrict on subcontractor_certificates', () => {
    assert(src.includes('selectStrict(TABLE'), 'selectStrict(TABLE) missing');
    assert(src.includes('subcontractor_certificates'), 'subcontractor_certificates reference missing');
  });

  check('certified amount = qty * rate (round 2) and SC-#### reference', () => {
    assert(/num\(qty\)\s*\*\s*num\(rate\)/.test(src), 'qty*rate math missing');
    assert(src.includes("'SC-'"), 'SC- reference prefix missing');
  });

  check('generate payment request wires payment_requests (subcontractor, submitted)', () => {
    assert(src.includes('payment_requests'), 'payment_requests reference missing');
    assert(src.includes("request_type: 'subcontractor'"), 'request_type subcontractor missing');
    assert(src.includes("status: 'submitted'"), 'status submitted missing');
    assert(src.includes('party_id: null'), 'party_id null missing');
    assert(src.includes('payment_request_id'), 'payment_request_id linking missing');
    assert(src.includes("'PR-'"), 'PR- reference prefix missing');
  });

  check('director-only certify gate is present', () => {
    assert(src.includes('director'), 'director role check missing');
  });

  check('docs/modules/subcertificates.md exists', () => {
    assert(existsSync(DOC), 'docs/modules/subcertificates.md missing');
  });

  if (!existsSync(MIGRATION)) {
    console.log('  ⏭ migration idempotency checks skipped (phase-3 migration not on disk yet)');
  } else {
    const mig = readFileSync(MIGRATION, 'utf8');
    check('migration creates subcontractor_certificates idempotently', () => {
      assert(/create\s+table\s+if\s+not\s+exists\s+(public\.)?subcontractor_certificates\b/i.test(mig), 'subcontractor_certificates create-table-if-not-exists missing');
    });
    check('subcontractor_certificates has status check (draft/certified/paid)', () => {
      assert(/draft/.test(mig) && /certified/.test(mig), 'status check values missing');
    });
  }
}

async function testkitChecks() {
  await acheck('subcertificates view renders in project context', async () => {
    await withApp({ role: 'director', project: 0 }, async ({ evaluate, goView, diagnostics }) => {
      diagnostics.clear();
      await goView('subcertificates');
      const text = await evaluate('document.getElementById("main").textContent');
      assert(text.includes('Measurement & Certificates'), 'title missing from #main');
      assert(diagnostics.errors.length === 0, diagnostics.errors.join(' | '));
    });
  });

  await acheck('compute + nextReference + create→certify→payment-request linking', async () => {
    await withApp({ role: 'director', project: 0 }, async ({ evaluate, goView, seedTable }) => {
      const ids = await evaluate(`(function(){
        var db=window.__MOCK_DB;
        var proj=db.projects[0];
        var boq=db.boq_items.filter(function(b){return b.project_id===proj.id;})[0];
        var sup=db.suppliers[0];
        return { project: proj.id, boq: boq.id, supplier: sup.id };
      })()`);
      await seedTable('subcontractor_certificates', []);
      await goView('subcertificates');
      const r = await evaluate(`(async function () {
        var m = window.SF_modules && window.SF_modules.subcertificates;
        if (!m) return null;
        var projectId = ${JSON.stringify(ids.project)};
        var compute = m.compute(3.5, 200);
        var ref = m.nextReference([{reference:'SC-0001'}]);
        var created = await m.create({ boq_item_id: ${JSON.stringify(ids.boq)}, supplier_id: ${JSON.stringify(ids.supplier)}, measured_qty: 3.5, rate_aed: 200 });
        var certId = created.ok ? created.row.id : null;
        var certified = created.ok ? await m.certify(certId) : null;
        var cachedBeforeGen = created.ok ? (m.list().filter(function (r) { return r.id === certId; })[0] || {}) : {};
        var gen = created.ok && certified.ok ? await m.generatePaymentRequest(certId) : null;
        var certRow = created.ok ? (await window.SF.db.client().from('subcontractor_certificates').select('*').eq('id', certId).single()) : null;
        return {
          compute: compute,
          ref: ref,
          createdOk: created.ok,
          createdErr: created.error && created.error.message,
          certifiedOk: !!(certified && certified.ok),
          certifiedErr: certified && certified.error && certified.error.message,
          genOk: !!(gen && gen.ok),
          genErr: gen && gen.error && gen.error.message,
          cachedStatusBeforeGen: cachedBeforeGen.status,
          prId: gen && gen.paymentRequest && gen.paymentRequest.id,
          certPaymentRequestId: certRow && certRow.data && certRow.data.payment_request_id,
          certStatus: certRow && certRow.data && certRow.data.status
        };
      })()`);
      assert(r, 'window.SF_modules.subcertificates missing');
      assertEqual(r.compute, 700, 'compute(3.5, 200) must equal 700');
      assertEqual(r.ref, 'SC-0002', 'nextReference after SC-0001 must be SC-0002');
      assertEqual(r.createdOk, true, 'create must succeed');
      assertEqual(r.certifiedOk, true, 'certify must succeed (director)' + (r.certifiedErr ? ' — ' + r.certifiedErr : ''));
      assertEqual(r.genOk, true, 'generatePaymentRequest must succeed' + (r.genErr ? ' — ' + r.genErr : '') + ' (cached status before gen: ' + r.cachedStatusBeforeGen + ')');
      assertEqual(r.certPaymentRequestId, r.prId, 'certificate must link the inserted payment request id');
      assertEqual(r.certStatus, 'certified', 'certificate status must be certified');
    });
  });
}

async function main() {
  console.log('\nSubcontractor Measurement & Certificates — static checks');
  staticChecks();

  const mockSrc = readFileSync(MOCK, 'utf8');
  const mockReady = /\bsubcontractor_certificates\b/.test(mockSrc);

  if (!mockReady) {
    console.log('\nSubcontractor Measurement & Certificates — testkit checks');
    console.log('  ⏭ skipped (mock not ready: tools/lib/mock-supabase.mjs has no subcontractor_certificates fixtures)');
  } else {
    console.log('\nSubcontractor Measurement & Certificates — testkit checks');
    await testkitChecks();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} subcertificates checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.error && f.error.message}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('Subcertificates checks failed to run:', error);
  process.exit(1);
});
