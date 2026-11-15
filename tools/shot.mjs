/**
 * Minimal Chrome DevTools Protocol driver (no dependencies, Node >= 22).
 *
 * Usage:
 *   node tools/shot.mjs --url http://127.0.0.1:5188/ --out docs/shots/x.png --wait 6000
 *   node tools/shot.mjs --url ... --out ... --wait 8000 --actions '[{"click":[500,407]},{"wait":2000}]'
 *
 * Prints console errors / exceptions and the value of window.__DSH_SHOT_STATE__ if set.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? 'http://127.0.0.1:5188/';
const out = args.out ?? 'docs/shots/shot.png';
const waitMs = Number(args.wait ?? 6000);
const width = Number(args.width ?? 1000);
const height = Number(args.height ?? 600);
const actions = args.actions ? JSON.parse(args.actions) : [];
const chromePath =
  args.chrome ??
  (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/usr/bin/google-chrome');

const profile = mkdtempSync(join(tmpdir(), 'dsh-shot-'));
const port = 9333 + Math.floor(Math.random() * 300);
const child = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let msgId = 0;
const pending = new Map();
const errors = [];
const logs = [];

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30000);
    pending.set(id, { resolve, reject, timer });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error('chrome did not expose a page target');
}

async function main() {
  const wsUrl = await getWsUrl();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`EXCEPTION: ${d.exception?.description ?? d.text} @${d.url ?? ''}:${d.lineNumber ?? ''}`);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ');
      if (msg.params.type === 'error') errors.push(`CONSOLE: ${text}`);
      else logs.push(`${msg.params.type}: ${text}`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') errors.push(`LOG: ${e.text} ${e.url ?? ''}`);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(waitMs);
  if (args.scenario) {
    const { pathToFileURL } = await import('node:url');
    const { resolve } = await import('node:path');
    await (await import(pathToFileURL(resolve(args.scenario)).href)).default({ send, sleep });
  }
  for (const action of actions) {
    if (action.wait) await sleep(action.wait);
    if (action.click) {
      const [x, y] = action.click;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(150);
    }
    if (action.move) {
      const [x, y] = action.move;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    }
    if (action.shot) {
      await sleep(action.shotWait ?? 400);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      mkdirSync(dirname(action.shot), { recursive: true });
      writeFileSync(action.shot, Buffer.from(shot.data, 'base64'));
      console.log(`wrote ${action.shot}`);
    }
  }
  const evalExpr = args.eval ?? '';
  if (evalExpr) {
    const value = await send('Runtime.evaluate', { expression: evalExpr, returnByValue: true, awaitPromise: true });
    console.log(`EVAL: ${JSON.stringify(value.result?.value ?? value.result?.description ?? null)}`);
  }
  const state = await send('Runtime.evaluate', {
    expression: 'window.__getState ? window.__getState() : (window.__SHOT_STATE__ ? JSON.stringify(window.__SHOT_STATE__) : "")',
    returnByValue: true,
  });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`wrote ${out}`);
  if (state.result?.value) console.log(`STATE: ${state.result.value}`);
  if (errors.length) {
    console.log(`ERRORS (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.log('  ' + e);
  } else {
    console.log('ERRORS: none');
  }
  if (logs.length) {
    console.log(`LOGS (${Math.min(logs.length, 10)}/${logs.length}):`);
    for (const l of logs.slice(0, 10)) console.log('  ' + l);
  }
}

main()
  .catch((err) => {
    console.error(err.stack ?? String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    child.kill();
  });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1];
  }
  return out;
}
