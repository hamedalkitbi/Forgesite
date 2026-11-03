// Full view smoke test: drives every built-in view (plus the module views registered through
// window.SF) as the Project Director, then verifies role-restricted views are denied for a
// Tradesperson Lead. Uses the shared testkit + mock Supabase harness.
//
// Usage: node tools/tests/app-views.mjs
// Exit code: 0 when every view renders with zero exceptions, 1 otherwise.

import assert from 'node:assert/strict';
import { withApp } from '../lib/testkit.mjs';

// Views are split by the sidebar section they belong to: company views are checked with no
// project selected, project views with PRJ-001 selected. (The app does not highlight a
// company-section nav item while a project is open, which would hide the active view id.)
const COMPANY_VIEWS = [
  'company-dash',
  'projects-list',
  'expenses',
  'company-budget',
  'workers',
  'compliance',
  'settings',
  'history',
  'approvals',
  'users',
  'finance'
];

const PROJECT_VIEWS = [
  'project-dash',
  'boq',
  'drawings',
  'timeline',
  'materials',
  'payments',
  'parties',
  'change-orders',
  'timesheets',
  'payroll',
  'audit',
  'reports',
  'progress-billing',
  'site-reports',
  'payment-requests',
  'payslips'
];

const DIRECTOR_VIEWS = COMPANY_VIEWS.concat(PROJECT_VIEWS);

// Views a Tradesperson Lead must not be able to open (not in PERMS.lead, not in any module roles).
const LEAD_RESTRICTED_VIEWS = ['payroll', 'users', 'approvals'];

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? '\n      ' + detail.split('\n').join('\n      ') : ''}`);
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

/** Render one view and assert it produced content and no JS exceptions. */
async function checkDirectorView(helpers, viewId) {
  helpers.diagnostics.clear();
  let renderedView = null;
  try {
    renderedView = await helpers.goView(viewId);
  } catch (error) {
    return { ok: false, detail: `goView("${viewId}") threw: ${errorMessage(error)}` };
  }
  const main = await helpers.evaluate(`(function(){
    var m=document.getElementById('main');
    if(!m)return {missing:true};
    return {text:(m.textContent||'').trim(),children:m.children.length};
  })()`);
  const exceptions = helpers.diagnostics.errors.slice();
  const problems = [];
  try {
    assert.ok(!main.missing, '#main is missing');
    assert.equal(renderedView, viewId, `currentView after goView("${viewId}") should be "${viewId}", got ${JSON.stringify(renderedView)}`);
    assert.ok(main.children > 0 || main.text.length > 0, `#main rendered no content for view "${viewId}"`);
    assert.equal(exceptions.length, 0, `JS exceptions while rendering "${viewId}": ${exceptions.slice(0, 4).join(' | ')}`);
  } catch (error) {
    problems.push(errorMessage(error));
  }
  return { ok: problems.length === 0, detail: problems.join('; ') };
}

/** A restricted view must be refused: currentView must not become the requested id. */
async function checkLeadDenial(helpers, viewId) {
  helpers.diagnostics.clear();
  const before = await helpers.currentView();
  let after = null;
  try {
    after = await helpers.goView(viewId);
  } catch (error) {
    return { ok: false, detail: `goView("${viewId}") threw: ${errorMessage(error)}` };
  }
  const exceptions = helpers.diagnostics.errors.slice();
  const problems = [];
  try {
    assert.notEqual(after, viewId, `view "${viewId}" should be denied for role lead; currentView became "${viewId}"`);
    assert.ok(after, 'currentView became null after a denied navigation');
    assert.equal(exceptions.length, 0, `JS exceptions after denied "${viewId}": ${exceptions.slice(0, 4).join(' | ')}`);
  } catch (error) {
    problems.push(errorMessage(error));
  }
  return { ok: problems.length === 0, detail: problems.join('; '), before, after };
}

async function main() {
  console.log('\nSiteForge — view smoke test (mock Supabase, headless Chrome)\n');

  console.log(`Director — company views (${COMPANY_VIEWS.length}), no project selected`);
  await withApp({ role: 'director' }, async (helpers) => {
    for (const viewId of COMPANY_VIEWS) {
      const result = await checkDirectorView(helpers, viewId);
      record(`director: ${viewId}`, result.ok, result.detail);
    }
  });

  console.log(`\nDirector — project views (${PROJECT_VIEWS.length}), project PRJ-001 selected`);
  await withApp({ role: 'director', project: 0 }, async (helpers) => {
    for (const viewId of PROJECT_VIEWS) {
      const result = await checkDirectorView(helpers, viewId);
      record(`director: ${viewId}`, result.ok, result.detail);
    }
  });

  console.log('\nLead — restricted views are denied');
  await withApp({ role: 'lead' }, async (helpers) => {
    const landing = await helpers.currentView();
    record('lead: initial view is allowed (not company-dash)', landing !== 'company-dash' && !!landing, `landing view: ${JSON.stringify(landing)}`);
    for (const viewId of LEAD_RESTRICTED_VIEWS) {
      const result = await checkLeadDenial(helpers, viewId);
      record(`lead denied: ${viewId}`, result.ok, result.detail);
    }
  });

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} view checks passed${failed ? `, ${failed} failed` : ''}\n`);
  if (failed) {
    console.log('Failures:');
    for (const failure of results.filter((result) => !result.ok)) {
      console.log(`  - ${failure.name}: ${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\nView smoke test could not run:', errorMessage(error));
  process.exitCode = 1;
});
