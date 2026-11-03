// Capture screenshots of the feature modules for review, signed in as a director
// against the mock Supabase backend. Output: docs/screenshots/<view>.png
// Usage: node tools/screenshots-modules.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './lib/cdp.mjs';
import { withApp } from './lib/testkit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');

const VIEWS = [
  { id: 'finance', file: 'finance-statements.png', settle: 2500 },
  { id: 'payment-requests', file: 'payment-requests.png', settle: 2000 },
  { id: 'payslips', file: 'payslips.png', settle: 2000 }
];

async function main() {
  await mkdir(OUT, { recursive: true });
  await withApp({ role: 'director', project: 'PRJ-001' }, async ({ client, goView, waitFor }) => {
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const view of VIEWS) {
      await goView(view.id);
      await waitFor(async () => await client.evaluate(`!!document.querySelector('[data-sf-${view.id.replace('-', '')}]') || (document.getElementById('main') && document.getElementById('main').textContent.length > 200)`));
      // For payslips, capture the generation preview rather than the empty state.
      if (view.id === 'payslips') {
        await client.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /generate/i.test(x.textContent || '')); if (b) b.click(); return !!b; })()`);
        await sleep(1200);
      }
      await sleep(view.settle);
      const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(join(OUT, view.file), Buffer.from(shot.result.data, 'base64'));
      console.log(`  ${view.id.padEnd(18)} -> docs/screenshots/${view.file}`);
    }
  });
}

main().catch((error) => { console.error('Module screenshot capture failed:', error); process.exit(1); });
