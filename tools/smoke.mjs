// Headless smoke test: loads the app, fails on any uncaught exception, console error,
// failed request or HTTP >= 400.
//
// Usage:
//   node tools/smoke.mjs [url]            (default http://127.0.0.1:8899/index.html)
//   npm run serve   # in another terminal, or let tools/run-tests.mjs start it
import { connect, collectDiagnostics, launchChrome, sleep } from './lib/cdp.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8899/index.html';
const settleMs = Number(process.argv[3] || 5000);

async function main() {
  const chrome = await launchChrome();
  const client = await connect(chrome.port);
  const diag = collectDiagnostics(client);
  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Network.enable');
    await client.send('Page.navigate', { url });
    await sleep(settleMs);

    const report = await client.evaluate(`(() => {
      const text = (id) => (document.getElementById(id) || {}).textContent || '';
      const sheetRules = (() => {
        try { return Array.from(document.styleSheets).reduce((n, s) => { try { return n + s.cssRules.length; } catch { return n; } }, 0); }
        catch { return -1; }
      })();
      return {
        title: document.title,
        readyState: document.readyState,
        loginVisible: (() => { const el = document.getElementById('loginScreen'); return !!el && getComputedStyle(el).display !== 'none'; })(),
        globalError: text('globalError').trim().slice(0, 500),
        version: text('version').trim(),
        supabaseLoaded: typeof window.supabase !== 'undefined',
        xlsxLoaded: typeof window.XLSX !== 'undefined',
        appReady: typeof window.doLogin === 'function',
        selftestHook: typeof window.__sf !== 'undefined',
        cssRuleCount: sheetRules,
        serviceWorkerSupported: 'serviceWorker' in navigator
      };
    })()`);

    console.log(JSON.stringify({ url, report, errors: diag.errors, warnings: [...new Set(diag.warnings)].slice(0, 10), logs: [...new Set(diag.logs)].slice(0, 10) }, null, 2));
    const failed = diag.errors.length > 0 || !report.loginVisible || !report.appReady || !!report.globalError;
    process.exitCode = failed ? 1 : 0;
  } finally {
    client.close();
    await chrome.close();
  }
}

main().catch((error) => { console.error('Smoke test harness failure:', error); process.exit(1); });
