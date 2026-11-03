// Capture login-screen screenshots (dark, light, Arabic/RTL, mobile) for visual review.
// Usage: node tools/screenshots.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, launchChrome, sleep } from './lib/cdp.mjs';
import { startServer } from './lib/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const SETTINGS_KEY = 'siteforge_settings_v1';

const SHOTS = [
  { name: 'login-dark-desktop', width: 1440, height: 900, settings: { theme: 'dark', language: 'en' } },
  { name: 'login-light-desktop', width: 1440, height: 900, settings: { theme: 'light', language: 'en' } },
  { name: 'login-arabic-desktop', width: 1440, height: 900, settings: { theme: 'dark', language: 'ar' } },
  { name: 'login-dark-mobile', width: 390, height: 844, mobile: true, settings: { theme: 'dark', language: 'en' } }
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await startServer(ROOT);
  const chrome = await launchChrome();
  const client = await connect(chrome.port);
  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    for (const shot of SHOTS) {
      const { identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, ${JSON.stringify(JSON.stringify(shot.settings))}); } catch (e) {}`
      }).then((res) => res.result);

      await client.send('Emulation.setDeviceMetricsOverride', {
        width: shot.width, height: shot.height, deviceScaleFactor: 1, mobile: !!shot.mobile
      });
      await client.send('Page.navigate', { url: `${server.url}/index.html?nosw=1` });
      await sleep(1600);

      const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const file = join(OUT, `${shot.name}.png`);
      await writeFile(file, Buffer.from(capture.result.data, 'base64'));
      console.log(`  ${shot.name.padEnd(24)} ${shot.width}x${shot.height}`);

      await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
  } finally {
    client.close();
    await chrome.close();
    await server.close();
  }
}

main().catch((error) => { console.error('Screenshot capture failed:', error); process.exit(1); });
