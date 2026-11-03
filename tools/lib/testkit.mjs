// Shared headless test harness for SiteForge.
//
// withApp(options, fn) boots the real app in headless Chrome against a mock Supabase,
// signs in as a role, optionally opens a project, hands the callback a set of helpers,
// and always tears Chrome/server down.
//
//   import { withApp, assert } from '../lib/testkit.mjs';
//
//   await withApp({ role: 'director', project: 0 }, async ({ goView, evaluate, diagnostics }) => {
//     await goView('boq');
//     assert((await evaluate('document.getElementById("main").textContent')).includes('BOQ'));
//     assert(diagnostics.errors.length === 0, diagnostics.errors.join(' | '));
//   });
//
// Zero npm dependencies. Node >= 20 (global fetch + WebSocket are used by cdp.mjs).

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDiagnostics, connect, launchChrome, sleep } from './cdp.mjs';
import { startServer } from './server.mjs';
import { MOCK_SOURCE } from './mock-supabase.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APP_URL_PATH = '/index.html?selftest=1&nosw=1';

const DEFAULT_OPTIONS = {
  role: 'director',
  project: null,
  settings: {},
  fixtureOverrides: null,
  settleMs: 260,
  timeoutMs: 30000
};

/** Assertion helper shared by the checks; throws with a readable message. */
export function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function requireAppSource() {
  const appPath = join(ROOT, 'scripts', 'app.js');
  let source = '';
  try {
    source = readFileSync(appPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read scripts/app.js: ${error.message}`);
  }
  if (!source.trim()) {
    throw new Error('scripts/app.js is empty (0 bytes) — restore it before running browser tests.');
  }
  if (source.indexOf('window.SF') < 0) {
    throw new Error('scripts/app.js has no window.SF module bridge — the harness needs the bridged app.js build.');
  }
  return source;
}

/**
 * Boot Chrome + static server + mock Supabase, sign in, then run fn.
 *
 * @param {object} options
 * @param {string} [options.role='director']    username to sign in as (director|controller|super|lead, or a custom username in fixtureOverrides.profiles)
 * @param {string|number|null} [options.project] project to open: uuid, project code, project name, or 0-based index
 * @param {{language?:string, theme?:string}} [options.settings] localStorage app settings
 * @param {object} [options.fixtureOverrides] { tableName: rows[] } replaces seeded tables before boot
 * @param {number} [options.settleMs=260]       extra wait after each helper navigation
 * @param {number} [options.timeoutMs=30000]    per-wait timeout
 * @param {string} [options.username]           explicit username when it differs from role
 * @param {function} fn callback({ client, server, chrome, evaluate, goView, waitFor, seedTable, getMockDb, getState, currentView, diagnostics })
 */
export async function withApp(options, fn) {
  if (typeof fn !== 'function') throw new Error('withApp(options, fn): fn callback is required');
  const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
  const username = opts.username || opts.role;
  const expectedRole = opts.role;
  requireAppSource();

  const server = await startServer(ROOT);
  const chrome = await launchChrome();
  let client = null;
  let diagnostics = null;

  const cleanup = async () => {
    try { if (client) client.close(); } catch { /* noop */ }
    try { await chrome.close(); } catch { /* noop */ }
    try { await server.close(); } catch { /* noop */ }
  };

  try {
    client = await connect(chrome.port);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Log.enable');

    diagnostics = collectDiagnostics(client);
    diagnostics.clear = () => {
      diagnostics.errors.length = 0;
      diagnostics.warnings.length = 0;
      diagnostics.logs.length = 0;
    };

    const evaluate = (expression) => client.evaluate(expression);

    const addScript = async (source) => {
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    };

    // 1. mock Supabase (must run before every page script)
    await addScript(MOCK_SOURCE);
    // 2. app settings + forget any remembered login
    const settings = Object.assign({ language: 'en', theme: 'dark' }, opts.settings || {});
    await addScript(
      `try{localStorage.setItem('siteforge_settings_v1', ${JSON.stringify(JSON.stringify(settings))});` +
      `localStorage.removeItem('siteforge_remember_v1');}catch(e){}`
    );
    // 3. fixture overrides
    if (opts.fixtureOverrides) {
      await addScript(`window.__applyMockOverrides(${JSON.stringify(opts.fixtureOverrides)});`);
    }

    const waitFor = async (predicate, waitOptions = {}) => {
      const timeout = waitOptions.timeout || opts.timeoutMs;
      const interval = waitOptions.interval || 150;
      const label = waitOptions.label || 'condition';
      const started = Date.now();
      for (;;) {
        let ok = false;
        try {
          ok = typeof predicate === 'function' ? await predicate() : await evaluate(predicate);
        } catch { /* keep polling */ }
        if (ok) return true;
        if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
        await sleep(interval);
      }
    };

    const mainHasContent = `(function(){var m=document.getElementById('main');return !!m && (m.children.length>0 || (m.textContent||'').trim().length>0);})()`;
    const currentViewExpression = `(function(){var b=document.querySelector('#sidebar .navitem.on');if(!b)return null;var oc=b.getAttribute('onclick')||'';var start=oc.indexOf("goView('");if(start<0)return null;start+=8;var end=oc.indexOf("')",start);return end<0?null:oc.slice(start,end);})()`;

    const currentView = async () => evaluate(currentViewExpression);

    const goView = async (viewId) => {
      await evaluate(`window.goView(${JSON.stringify(String(viewId))})`);
      await sleep(40);
      await waitFor(mainHasContent, { label: `#main to render for view "${viewId}"` });
      await sleep(opts.settleMs);
      return currentView();
    };

    const seedTable = async (table, rows) => {
      await evaluate(`window.__MOCK.seedTable(${JSON.stringify(String(table))}, ${JSON.stringify(rows || [])});true`);
      return rows || [];
    };

    const getMockDb = async () => evaluate('window.__MOCK_DB');
    const getState = async () => evaluate('(window.SF && window.SF.data && window.SF.data.state) || null');

    // Boot the app.
    await client.send('Page.navigate', { url: server.url + APP_URL_PATH });
    await waitFor(
      `document.readyState === 'complete' && typeof window.doLogin === 'function' && !!window.__MOCK_DB`,
      { label: 'app bootstrap' }
    );

    const bridgeReady = await evaluate(`typeof window.SF !== 'undefined' && !!window.SF.registerView`);
    if (!bridgeReady) {
      throw new Error('window.SF bridge is missing after boot — check that scripts/app.js ships the module bridge.');
    }

    // Drive the login form exactly like a user (set values, then submit through doLogin()).
    const loginStarted = await evaluate(`(function(){
      var u=document.getElementById('loginUser');
      var p=document.getElementById('loginPass');
      if(!u||!p)return false;
      u.value=${JSON.stringify(username)};
      p.value='demo-password';
      u.dispatchEvent(new Event('input',{bubbles:true}));
      p.dispatchEvent(new Event('input',{bubbles:true}));
      window.doLogin();
      return true;
    })()`);
    if (!loginStarted) throw new Error('Login form inputs #loginUser/#loginPass are missing');

    await waitFor(
      `(function(){
        var shell=document.getElementById('appShell');
        var shown=!!shell && getComputedStyle(shell).display!=='none';
        var err=(document.getElementById('loginError')||{}).textContent||'';
        if(err) throw new Error(err);
        return shown && !!(window.SF&&window.SF.user) && window.SF.user.role===${JSON.stringify(expectedRole)};
      })()`,
      { label: `signed in as ${username} (role ${expectedRole})` }
    );
    await waitFor(mainHasContent, { label: 'initial view to render' });
    await sleep(opts.settleMs);

    let projectId = null;
    if (opts.project !== null && opts.project !== undefined) {
      projectId = await evaluate(`(async function(){
        var projects=(window.__MOCK_DB&&window.__MOCK_DB.projects)||[];
        var wanted=${JSON.stringify(opts.project)};
        var proj=null;
        if(typeof wanted==='number')proj=projects[wanted];
        else{for(var i=0;i<projects.length;i++){if(projects[i].id===wanted||projects[i].code===wanted||projects[i].name===wanted){proj=projects[i];break;}}}
        if(!proj)return null;
        await window.switchProject(proj.id);
        return window.SF.currentProjectId;
      })()`);
      if (!projectId) throw new Error(`withApp: project not found: ${JSON.stringify(opts.project)}`);
      await waitFor(`window.SF && window.SF.currentProjectId === ${JSON.stringify(projectId)}`, { label: 'project selection' });
      await sleep(opts.settleMs);
    }

    const helpers = {
      client,
      server,
      chrome,
      evaluate,
      goView,
      waitFor,
      seedTable,
      getMockDb,
      getState,
      currentView,
      diagnostics,
      projectId,
      role: expectedRole,
      username
    };

    return await fn(helpers);
  } finally {
    await cleanup();
  }
}

/**
 * Tiny assertion runner for tools/checks/*.mjs. Each test is { name, fn } where fn may be async.
 * Prints ✓/✗ lines and a summary; returns { passed, failed, results } (caller sets process.exitCode).
 */
export async function runFeatureChecks({ name = 'Feature checks', tests = [] } = {}) {
  const results = [];
  console.log(`\n${name}`);
  for (const test of tests) {
    if (!test || typeof test.fn !== 'function') {
      throw new Error(`runFeatureChecks: test "${test && test.name}" needs an fn`);
    }
    try {
      await test.fn();
      results.push({ name: test.name, ok: true, detail: '' });
      console.log(`  ✓ ${test.name}`);
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      results.push({ name: test.name, ok: false, detail });
      console.log(`  ✗ ${test.name}\n      ${detail.split('\n').join('\n      ')}`);
    }
  }
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} failed` : ''}\n`);
  if (failed) {
    console.log('Failures:');
    for (const failure of results.filter((result) => !result.ok)) console.log(`  - ${failure.name}: ${failure.detail}`);
  }
  return { passed, failed, results };
}
