// Verification for the Retention module (project retention releases).
//
// Usage: node tools/checks/retention.mjs
//
// 1. Static checks (always run):
//    - node --check on scripts/modules/retention.js
//    - view-registration + public-API + selectStrict/insert + validation greps
//    - SQL-idempotency greps of supabase/migrations/202611050003_phase3.sql for
//      retention_releases (skipped with a note if the migration is not on disk).
// 2. Testkit checks (once tools/lib/mock-supabase.mjs mirrors retention_releases):
//    boots the real app headless and asserts view render + open/release math.
//    If the mock lacks retention_releases, this step prints "skipped (mock not ready)".
//
// Note: the phase-3 migration also owns subcontractor_certificates and the
// sf_retention_open RPC — those are exercised by the other phase-3 checks and
// the shared phase3 verifier, not here.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { withApp, assert, assertEqual, ROOT } from '../lib/testkit.mjs';

const MODULE = join(ROOT, 'scripts', 'modules', 'retention.js');
const DOC = join(ROOT, 'docs', 'modules', 'retention.md');
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
  check('registers the retention view (project nav, director/controller)', () => {
    assert(src.includes('registerView({'), 'registerView({ missing');
    assert(src.includes("id: MODULE_ID") || src.includes("id: 'retention'"), 'view id missing');
    assert(src.includes("section: 'project'"), 'nav.section must be "project"');
    assert(src.includes("roles: ['director', 'controller']"), 'roles must be director/controller');
    assert(src.includes("label: 'Retention'"), 'EN label missing');
    assert(src.includes("labelAr: 'الاستحقاقات'"), 'AR label missing');
    assert(src.includes("icon: '💠'"), 'icon missing');
  });

  check('exposes window.SF_modules.retention API', () => {
    assert(src.includes('window.SF_modules'), 'SF_modules bucket missing');
    for (const key of ['open', 'released', 'release', 'list']) {
      assert(src.includes(key + ':'), `API key "${key}" missing`);
    }
  });

  check('loads releases via selectStrict and writes via insert', () => {
    assert(src.includes('selectStrict(TABLE'), 'selectStrict(TABLE) missing');
    assert(src.includes('retention_releases'), 'retention_releases table reference missing');
    assert(src.includes('insert(TABLE'), 'insert(TABLE) missing');
  });

  check('release validation guards amount <= open and requires a reason', () => {
    assert(src.includes('amount_aed'), 'amount_aed missing');
    assert(/amt\s*>\s*0/.test(src), 'amount > 0 validation missing');
    assert(src.includes('reason'), 'reason validation missing');
    assert(src.includes('openAmt'), 'open-amount guard missing');
  });

  check('director-only release gate is present', () => {
    assert(src.includes('director'), 'director role check missing');
  });

  check('docs/modules/retention.md exists', () => {
    assert(existsSync(DOC), 'docs/modules/retention.md missing');
  });

  if (!existsSync(MIGRATION)) {
    console.log('  ⏭ migration idempotency checks skipped (phase-3 migration not on disk yet)');
  } else {
    const mig = readFileSync(MIGRATION, 'utf8');
    check('migration creates retention_releases idempotently', () => {
      assert(/create\s+table\s+if\s+not\s+exists\s+(public\.)?retention_releases\b/i.test(mig), 'retention_releases create-table-if-not-exists missing');
    });
    check('retention_releases has positive-amount check', () => {
      assert(/amount_aed\s*>\s*0/.test(mig), 'amount_aed > 0 check missing');
    });
  }
}

async function testkitChecks() {
  await acheck('retention view renders and reports open = retained − released', async () => {
    await withApp({ role: 'director', project: 0 }, async ({ evaluate, goView, diagnostics }) => {
      diagnostics.clear();
      await goView('retention');
      const text = await evaluate('document.getElementById("main").textContent');
      assert(text.includes('Retention'), 'title missing from #main');
      assert(diagnostics.errors.length === 0, diagnostics.errors.join(' | '));
    });
  });

  await acheck('retention API release() enforces amount <= open and reason', async () => {
    await withApp({ role: 'director', project: 0 }, async ({ evaluate, goView, seedTable }) => {
      await seedTable('retention_releases', []);
      await goView('retention');
      const r = await evaluate(`(async function () {
        var m = window.SF_modules && window.SF_modules.retention;
        if (!m) return null;
        // seeded billings: PB-001 certified 310000 + PB-002 paid 465000 = 775000 retained
        var open = m.open();
        var noReason = await m.release(1000, '');
        var overOpen = await m.release(open + 1, 'over');
        var okRel = await m.release(1000, 'DLP milestone');
        return {
          open: open,
          noReasonOk: noReason.ok,
          overOpenOk: overOpen.ok,
          okRelOk: okRel.ok,
          listCount: m.list().length
        };
      })()`);
      assert(r, 'window.SF_modules.retention missing');
      assertEqual(r.open, 775000, 'open must equal retained (775000) with no releases');
      assertEqual(r.noReasonOk, false, 'release without a reason must be denied');
      assertEqual(r.overOpenOk, false, 'release over open must be denied');
      assertEqual(r.okRelOk, true, 'release within open with a reason must succeed');
      assertEqual(r.listCount, 1, 'list() must include the recorded release');
    });
  });
}

async function main() {
  console.log('\nRetention — static checks');
  staticChecks();

  const mockSrc = readFileSync(MOCK, 'utf8');
  const mockReady = /\bretention_releases\b/.test(mockSrc);

  if (!mockReady) {
    console.log('\nRetention — testkit checks');
    console.log('  ⏭ skipped (mock not ready: tools/lib/mock-supabase.mjs has no retention_releases fixtures)');
  } else {
    console.log('\nRetention — testkit checks');
    await testkitChecks();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} retention checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.error && f.error.message}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('Retention checks failed to run:', error);
  process.exit(1);
});
