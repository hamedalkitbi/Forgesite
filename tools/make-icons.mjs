// Render icon.svg into the PNG sizes required by site.webmanifest and iOS.
// Usage: node tools/make-icons.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, launchChrome, sleep } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'icons');

const TARGETS = [
  { file: 'icon-192.png', size: 192, maskable: false, opaque: false },
  { file: 'icon-512.png', size: 512, maskable: false, opaque: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true, opaque: true },
  { file: 'apple-touch-icon-180.png', size: 180, maskable: false, opaque: true }
];

async function render(client, spec, svgMarkup) {
  const { size, maskable, opaque } = spec;
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: size, height: size, deviceScaleFactor: 1, mobile: false
  });
  await client.send('Emulation.setDefaultBackgroundColorOverride', {
    color: opaque
      ? { r: 11, g: 15, b: 20, a: 1 }
      : { r: 0, g: 0, b: 0, a: 0 }
  });

  // Maskable icons must keep their content inside the central 80% safe zone.
  const inner = maskable
    ? `<div style="width:100%;height:100%;background:#0b0f14;display:grid;place-items:center">
         <div style="width:72%;height:72%">${svgMarkup}</div>
       </div>`
    : svgMarkup;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
      svg{display:block;width:100%;height:100%}
    </style></head><body>${inner}</body></html>`;

  await client.evaluate(`document.open();document.write(${JSON.stringify(html)});document.close();`);
  await sleep(120);

  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 }
  });
  const buffer = Buffer.from(shot.result.data, 'base64');
  const outPath = join(ICON_DIR, spec.file);
  await writeFile(outPath, buffer);
  return { file: spec.file, bytes: buffer.length };
}

async function main() {
  const svgMarkup = (await readFile(join(ICON_DIR, 'icon.svg'), 'utf8'))
    .replace(/<\?xml[^>]*>/g, '')
    .trim();
  await mkdir(ICON_DIR, { recursive: true });

  const chrome = await launchChrome();
  let client;
  try {
    client = await connect(chrome.port);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    for (const spec of TARGETS) {
      const result = await render(client, spec, svgMarkup);
      console.log(`  ${result.file.padEnd(26)} ${spec.size}px  ${(result.bytes / 1024).toFixed(1)} KB`);
    }
  } finally {
    client?.close();
    await chrome.close();
  }
  console.log('Icons written to icons/');
}

main().catch((error) => { console.error('Icon generation failed:', error); process.exit(1); });
