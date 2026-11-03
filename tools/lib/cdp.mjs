// Minimal Chrome DevTools Protocol driver. Zero npm dependencies (Node >= 20 global WebSocket).
// Used by tools/smoke.mjs, tools/run-tests.mjs and tools/make-icons.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium'
].filter(Boolean);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome/Chromium binary found. Set CHROME_PATH to your browser executable.');
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, { timeout = 20000, interval = 150, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* keep polling */
    }
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(interval);
  }
}

/**
 * Launch headless Chrome with remote debugging enabled.
 * --no-sandbox is required when Chrome itself runs inside an outer sandbox
 * (CI containers, DSH file sandbox); harmless on normal developer machines.
 */
export async function launchChrome({ port, profileDir } = {}) {
  const binary = findChrome();
  const debugPort = port || (await freePort());
  const profile = profileDir || mkdtempSync(join(tmpdir(), 'forgesite-chrome-'));
  const logPath = join(profile, 'chrome.log');
  // CI runners are slow to bring Chromium up (dbus probes, image layers); be patient.
  const startupTimeout = Number(process.env.CHROME_STARTUP_TIMEOUT_MS || 60000);
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dbus',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    'about:blank'
  ];
  const out = openSync(logPath, 'a');
  const proc = spawn(binary, args, {
    stdio: ['ignore', out, out],
    // Not having a session bus makes Chromium probe dbus for ~20s on CI.
    env: Object.assign({}, process.env, { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null' })
  });
  proc.on('error', () => {});

  try {
    await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return res.ok;
    }, { label: 'Chrome devtools endpoint', timeout: startupTimeout });
  } catch (error) {
    let tail = '';
    try { tail = readFileSync(logPath, 'utf8').split('\n').slice(-6).join('\n'); } catch { /* no log */ }
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    throw new Error(`${error.message} after ${startupTimeout}ms (set CHROME_STARTUP_TIMEOUT_MS to raise). Chrome log tail:\n${tail}`);
  }

  return {
    proc,
    port: debugPort,
    profileDir: profile,
    logPath,
    async close() {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      await sleep(350);
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}

/** Open a new tab and return a CDP client bound to it. */
export async function connect(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?url=about:blank`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Could not create CDP target (${res.status})`);
  const target = await res.json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP websocket failed to open'));
  });

  let nextId = 0;
  const pending = new Map();
  const events = [];
  const listeners = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    events.push(msg);
    const fns = listeners.get(msg.method);
    if (fns) for (const fn of fns) fn(msg.params);
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30000);
    timer.unref?.();
  });

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const details = res.result?.exceptionDetails;
    if (details) {
      const text = details.exception?.description || details.text || 'evaluation failed';
      throw new Error(text.split('\n')[0]);
    }
    return res.result?.result?.value;
  };

  const sendSync = () => {};

  return {
    send,
    evaluate,
    on,
    events,
    close: () => { try { ws.close(); } catch { /* noop */ } },
    sendSync
  };
}

/** Collect console errors, uncaught exceptions, failed requests and non-2xx responses. */
export function collectDiagnostics(client) {
  const diagnostics = { errors: [], warnings: [], logs: [] };
  client.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    const where = d.url ? ` (${d.url.split('/').pop()}:${d.lineNumber + 1})` : '';
    diagnostics.errors.push(`EXCEPTION ${d.exception?.description?.split('\n')[0] || d.text}${where}`);
  });
  client.on('Log.entryAdded', ({ entry }) => {
    const line = `${entry.text}${entry.url ? ' (' + entry.url.split('/').pop() + ')' : ''}`;
    if (entry.level === 'error') diagnostics.errors.push(line);
    else if (entry.level === 'warning') diagnostics.warnings.push(line);
    else diagnostics.logs.push(line);
  });
  client.on('Runtime.consoleAPICalled', ({ type, args }) => {
    const text = args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    if (type === 'error') diagnostics.errors.push('console.error: ' + text);
    else if (type === 'warning' || type === 'assert') diagnostics.warnings.push(`console.${type}: ${text}`);
    else diagnostics.logs.push(text);
  });
  client.on('Network.loadingFailed', ({ errorText, type, canceled }) => {
    if (!canceled) diagnostics.errors.push(`network failed: ${type} ${errorText}`);
  });
  client.on('Network.responseReceived', ({ response }) => {
    if (response.status >= 400) diagnostics.errors.push(`HTTP ${response.status} ${response.url}`);
  });
  return diagnostics;
}

/** node --check on a JS file; returns null when valid, else the parser error text. */
export function checkJsSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) return null;
  return (result.stderr || result.stdout || 'syntax error').trim().split('\n').slice(0, 3).join(' ');
}
