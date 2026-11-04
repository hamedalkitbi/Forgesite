// Capture role-based guide screenshots from the running app (mock Supabase, per-role login).
// Output: docs/screenshots/guides/<role>/<view>.png  (+ login.png)
// Usage: node tools/screenshots-guides.mjs
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './lib/cdp.mjs';
import { withApp } from './lib/testkit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots', 'guides');

const COMPANY = ['company-dash', 'projects-list', 'expenses', 'company-budget', 'workers', 'compliance', 'settings', 'users', 'history', 'approvals', 'finance', 'suppliers', 'management'];
const PROJECT = ['project-dash', 'boq', 'drawings', 'timeline', 'materials', 'payments', 'parties', 'change-orders', 'timesheets', 'payroll', 'audit', 'reports', 'progress-billing', 'site-reports', 'payment-requests', 'payslips', 'grn', 'retention', 'subcertificates'];

const ROLES = {
  director: {
    company: COMPANY,
    project: PROJECT
  },
  controller: {
    company: COMPANY.filter((v) => v !== 'users' && v !== 'history'),
    project: PROJECT
  },
  super: {
    company: ['company-dash', 'projects-list', 'workers', 'compliance', 'settings'],
    project: ['project-dash', 'boq', 'drawings', 'timeline', 'materials', 'payments', 'parties', 'change-orders', 'timesheets', 'audit', 'reports', 'site-reports', 'payment-requests', 'grn']
  },
  lead: {
    company: ['projects-list', 'settings'],
    project: ['project-dash', 'drawings', 'timeline', 'materials', 'timesheets', 'site-reports']
  }
};

async function shoot(client, role, context, view) {
  await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).then(async (shot) => {
    const dir = join(OUT, role);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${context}-${view}.png`);
    await writeFile(file, Buffer.from(shot.result.data, 'base64'));
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // Login screen (reuse the existing capture)
  await copyFile(join(ROOT, 'docs', 'screenshots', 'login-dark-desktop.png'), join(OUT, 'login.png'));

  for (const role of Object.keys(ROLES)) {
    const spec = ROLES[role];

    // Company context (no project)
    await withApp({ role, settings: { theme: 'dark' } }, async ({ client, goView, waitFor }) => {
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const view of spec.company) {
        await goView(view);
        await waitFor(async () => await client.evaluate(`(document.getElementById('main')||{}).textContent && document.getElementById('main').textContent.length > 60`), { timeout: 8000, label: view }).catch(() => {});
        await sleep(1200);
        await shoot(client, role, 'company', view);
      }
    });

    // Project context
    await withApp({ role, project: 'PRJ-001', settings: { theme: 'dark' } }, async ({ client, goView, waitFor }) => {
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const view of spec.project) {
        await goView(view);
        await waitFor(async () => await client.evaluate(`(document.getElementById('main')||{}).textContent && document.getElementById('main').textContent.length > 60`), { timeout: 8000, label: view }).catch(() => {});
        await sleep(1200);
        await shoot(client, role, 'project', view);
      }
    });

    console.log(`  ${role}: ${spec.company.length} company + ${spec.project.length} project views`);
  }

  console.log('\nGuides screenshots written to docs/screenshots/guides/');
}

main().catch((error) => { console.error('Guide screenshot capture failed:', error); process.exit(1); });
