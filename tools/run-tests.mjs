// Zero-dependency test suite: static assets, PWA manifest, runtime smoke, pure-helper
// unit tests, accessibility basics and offline app-shell behavior.
//
// Usage: node tools/run-tests.mjs   (or: npm test)
// Starts its own static server and headless Chrome, then cleans both up.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkJsSyntax, collectDiagnostics, connect, launchChrome, sleep } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? '\n      ' + detail : ''}`);
}
async function test(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (error) {
    record(name, false, String(error && error.message ? error.message : error));
  }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function startServer(root) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const filePath = normalize(join(root, pathname));
      if (!filePath.startsWith(normalize(root))) { res.writeHead(403); res.end('forbidden'); return; }
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

async function waitFor(predicate, { timeout = 20000, interval = 200, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    try { if (await predicate()) return; } catch { /* poll again */ }
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

async function main() {
  const server = await startServer(ROOT);
  const chrome = await launchChrome();
  const client = await connect(chrome.port);
  const diag = collectDiagnostics(client);

  const cleanup = async () => {
    try { client.close(); } catch { /* noop */ }
    await chrome.close();
    await server.close();
  };

  console.log('\nForgesite test suite\n');
  console.log('Static assets');
  for (const path of [
    '/', '/index.html', '/styles/main.css', '/scripts/app.js', '/sw.js', '/site.webmanifest',
    '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
    '/icons/icon-maskable-512.png', '/icons/apple-touch-icon-180.png'
  ]) {
    await test(`serves ${path}`, async () => {
      const response = await fetch(server.url + path);
      assert(response.ok, `HTTP ${response.status}`);
    });
  }

  console.log('\nStatic analysis');
  await test('scripts/app.js parses', () => {
    const error = checkJsSyntax(join(ROOT, 'scripts/app.js'));
    assert(!error, error);
  });
  await test('sw.js parses', () => {
    const error = checkJsSyntax(join(ROOT, 'sw.js'));
    assert(!error, error);
  });
  await test('site.webmanifest has required PWA fields', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'site.webmanifest'), 'utf8'));
    assert(manifest.name && manifest.short_name, 'name/short_name missing');
    eq(manifest.display, 'standalone', 'display');
    const sizes = manifest.icons.map((icon) => icon.sizes);
    assert(sizes.includes('192x192') && sizes.includes('512x512'), 'icons 192x192 + 512x512 required');
    assert(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'maskable icon required');
    assert(manifest.start_url && manifest.scope, 'start_url/scope required');
  });

  console.log('\nRuntime');
  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Network.enable');

    const pageUrl = `${server.url}/index.html?selftest=1&nosw=1`;
    await client.send('Page.navigate', { url: pageUrl });
    await waitFor(async () => await client.evaluate('document.readyState === "complete" && typeof window.doLogin === "function"'), { label: 'app bootstrap' });
    await sleep(1200);

    await test('boots without JS exceptions', async () => {
      assert(diag.errors.length === 0, diag.errors.slice(0, 4).join(' | '));
    });

    const dom = await client.evaluate(`(() => {
      const text = (id) => (document.getElementById(id) || {}).textContent || '';
      return {
        title: document.title,
        lang: document.documentElement.lang,
        loginVisible: !!document.getElementById('loginScreen') && getComputedStyle(document.getElementById('loginScreen')).display !== 'none',
        globalError: text('globalError').trim(),
        supabaseLoaded: typeof window.supabase !== 'undefined',
        xlsxLoaded: typeof window.XLSX !== 'undefined',
        hook: typeof window.__sf,
        modalRole: (document.getElementById('modalRoot') || {}).getAttribute ? document.getElementById('modalRoot').getAttribute('role') : null
      };
    })()`);

    await test('login screen renders', async () => {
      assert(dom.loginVisible, 'loginScreen is hidden');
      assert(dom.title.includes('SiteForge'), `unexpected title: ${dom.title}`);
    });
    await test('no global error banner', () => assert(!dom.globalError, dom.globalError));
    await test('CDN libraries are available', () => {
      assert(dom.supabaseLoaded, 'window.supabase missing');
      assert(dom.xlsxLoaded, 'window.XLSX missing');
    });
    await test('self-test hook is exposed', () => eq(dom.hook, 'object', 'typeof window.__sf'));

    const units = await client.evaluate(`(() => {
      const s = window.__sf;
      const dateParts = (value) => { const d = s.toLocalDate(value); return d ? [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-') : null; };
      return {
        money: s.money(1234.5),
        moneyNegative: s.money(-5),
        moneyZero: s.money(0),
        money0: s.money0(1234.5),
        num: s.num(2),
        numOrEmpty: s.numOr('', 7),
        numOrNan: s.numOr('abc', 3),
        numOrZero: s.numOr(0, 9),
        escTag: s.esc('<div>'),
        escAmp: s.esc('&'),
        escQuote: s.esc('"'),
        dateOnly: dateParts('2026-11-03'),
        dateTimestamp: s.toLocalDate('2026-11-03T10:20:30Z') instanceof Date,
        dateEmpty: s.toLocalDate('') === null,
        fmtDate: s.fmtDate('2026-11-03'),
        daysToday: s.daysUntil(s.today()),
        todayShape: /^\\d{4}-\\d{2}-\\d{2}$/.test(s.today()),
        imgJavascript: s.safeImgSrc('javascript:alert(1)'),
        imgData: s.safeImgSrc('data:image/png;base64,AAAA'),
        cellFormula: s.safeSpreadsheetCell('=1+1'),
        cellNumber: s.safeSpreadsheetCell(5),
        uuid: s.genUUID()
      };
    })()`);

    console.log('\nPure helpers');
    await test('money() formats AED with 2dp and sign', () => {
      eq(units.money, 'AED 1,234.50', 'money(1234.5)');
      eq(units.moneyNegative, '-AED 5.00', 'money(-5)');
      eq(units.moneyZero, 'AED 0.00', 'money(0)');
      eq(units.money0, 'AED 1,235', 'money0(1234.5)');
    });
    await test('num()/numOr() coerce without NaN', () => {
      eq(units.num, '2.00', 'num(2)');
      eq(units.numOrEmpty, 7, "numOr('',7)");
      eq(units.numOrNan, 3, "numOr('abc',3)");
      eq(units.numOrZero, 0, 'numOr(0,9)');
    });
    await test('esc() escapes HTML metacharacters', () => {
      eq(units.escTag, '&lt;div&gt;', 'esc(<div>)');
      eq(units.escAmp, '&amp;', 'esc(&)');
      eq(units.escQuote, '&quot;', 'esc(")');
    });
    await test('date helpers keep date-only strings on the same local day', () => {
      eq(units.dateOnly, '2026-11-3', 'toLocalDate(2026-11-03)');
      eq(units.dateTimestamp, true, 'ISO timestamp parses');
      eq(units.dateEmpty, true, "toLocalDate('') is null");
      eq(units.fmtDate, 'Nov 03, 2026', 'fmtDate');
      eq(units.daysToday, 0, 'daysUntil(today())');
      eq(units.todayShape, true, 'today() shape');
    });
    await test('image and spreadsheet sinks are hardened', () => {
      eq(units.imgJavascript, '', 'javascript: URL rejected');
      eq(units.imgData, 'data:image/png;base64,AAAA', 'data URL preserved');
      eq(units.cellFormula, "'=1+1", 'formula cell prefixed');
      eq(units.cellNumber, 5, 'numeric cell untouched');
    });
    await test('genUUID() returns a v4 UUID', () => {
      assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(units.uuid), `bad uuid: ${units.uuid}`);
    });

    console.log('\nAccessibility basics');
    const a11y = await client.evaluate(`(() => {
      const inputs = [...document.querySelectorAll('#loginScreen input')];
      const unlabeled = inputs.filter((el) => {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
        if (el.closest('label')) return false;
        return !(el.id && document.querySelector('label[for="' + el.id + '"]'));
      }).map((el) => el.id || el.name || el.type);
      const unlabeledButtons = [...document.querySelectorAll('button')].filter((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).length;
      return {
        lang: document.documentElement.lang,
        unlabeledInputs: unlabeled,
        unlabeledButtons,
        hasRoleDialog: !!document.querySelector('#modalRoot[role="dialog"]')
      };
    })()`);
    await test('document declares a language', () => assert(a11y.lang, 'html[lang] missing'));
    await test('login inputs all have labels', () => assert(a11y.unlabeledInputs.length === 0, 'unlabeled: ' + a11y.unlabeledInputs.join(', ')));
    await test('modal root exposes dialog role', () => assert(a11y.hasRoleDialog, 'role=dialog missing'));

    console.log('\nOffline (service worker)');
    await client.send('Page.navigate', { url: `${server.url}/index.html` });
    await waitFor(async () => await client.evaluate('document.readyState === "complete" && typeof window.doLogin === "function"'), { label: 'sw page bootstrap' });
    await test('service worker registers and caches the shell', async () => {
      await waitFor(async () => await client.evaluate('navigator.serviceWorker.getRegistrations().then((r) => r.length > 0)'), { timeout: 20000, label: 'service worker registration' });
      await waitFor(async () => await client.evaluate(`caches.keys().then((keys) => keys.some((k) => k.indexOf('forgesite-') === 0))`), { timeout: 20000, label: 'shell cache' });
      // Second load must be controlled by the worker before the offline check is meaningful.
      await client.send('Page.reload');
      await waitFor(async () => await client.evaluate('!!navigator.serviceWorker.controller'), { timeout: 20000, label: 'sw controller' });
    });
    await test('app shell loads while offline', async () => {
      await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      try {
        await client.send('Page.reload');
        await sleep(3000);
        const offline = await client.evaluate(`(() => {
          const screen = document.getElementById('loginScreen');
          return {
            loginVisible: !!screen && getComputedStyle(screen).display !== 'none',
            error: ((document.getElementById('globalError') || {}).textContent || '').trim()
          };
        })()`);
        assert(offline.loginVisible, 'cached shell did not render offline');
        assert(!offline.error, 'global error offline: ' + offline.error);
      } finally {
        await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      }
    });
  } finally {
    await cleanup();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} failed` : ''}\n`);
  if (failed) {
    console.log('Failures:');
    for (const failure of results.filter((r) => !r.ok)) console.log(`  - ${failure.name}: ${failure.detail}`);
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch(async (error) => {
  console.error('\nTest harness failure:', error);
  process.exit(1);
});
