#!/usr/bin/env node

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const port = Number(process.env.OPENCHAMBER_TAILNET_CONTROL_PORT || '8780');
const switchBin = process.env.OPENCHAMBER_SWITCH_BIN || path.join(os.homedir(), '.local', 'bin', 'openchamber-switch');
const runtimeHost = process.env.OPENCHAMBER_TAILNET_RUNTIME_HOST || '';
const runtimes = {
  regular: { label: 'Official', port: 8792 },
  custom: { label: 'Custom', port: 8795 },
};
let switchInFlight = false;

const controlPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>OpenChamber Runtime</title>
    <style>
      :root {
        color-scheme: light dark;
        --background: Canvas;
        --foreground: CanvasText;
        --surface: color-mix(in srgb, CanvasText 6%, Canvas);
        --surface-strong: color-mix(in srgb, CanvasText 10%, Canvas);
        --border: color-mix(in srgb, CanvasText 20%, transparent);
        --muted: color-mix(in srgb, CanvasText 64%, transparent);
        --accent: AccentColor;
        --accent-foreground: AccentColorText;
        --focus: Highlight;
        --success: color-mix(in srgb, green 72%, CanvasText);
        --warning: color-mix(in srgb, darkorange 76%, CanvasText);
      }

      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        padding: 32px 20px;
        background: var(--background);
        color: var(--foreground);
        font-family: ui-sans-serif, system-ui, sans-serif;
      }
      main { width: min(760px, 100%); margin: 0 auto; }
      header { margin-bottom: 28px; }
      .eyebrow {
        margin: 0 0 10px;
        color: var(--muted);
        font: 650 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: .14em;
        text-transform: uppercase;
      }
      h1 { margin: 0; font-size: clamp(34px, 7vw, 58px); letter-spacing: -.055em; line-height: 1; }
      .lede { max-width: 560px; margin: 14px 0 0; color: var(--muted); line-height: 1.55; }
      .status {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin: 0 0 16px;
        padding: 16px 18px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--surface);
      }
      .status strong { display: block; margin-bottom: 4px; }
      .status small { color: var(--muted); }
      .indicator { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 50%; background: var(--muted); }
      .indicator.active { background: var(--success); }
      .indicator.warning { background: var(--warning); }
      .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      .card {
        display: flex;
        min-height: 230px;
        flex-direction: column;
        justify-content: space-between;
        gap: 24px;
        padding: 22px;
        border: 1px solid var(--border);
        border-radius: 18px;
        background: var(--surface);
      }
      .card.active { border-color: var(--accent); background: var(--surface-strong); }
      .card h2 { margin: 0; font-size: 24px; letter-spacing: -.035em; }
      .card p { margin: 8px 0 0; color: var(--muted); line-height: 1.45; }
      .meta { margin-top: 16px; color: var(--muted); font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
      button, a {
        min-height: 42px;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px 14px;
        font: inherit;
        font-weight: 650;
        text-decoration: none;
        cursor: pointer;
      }
      button { background: var(--accent); color: var(--accent-foreground); border-color: transparent; }
      button:hover:not(:disabled), a:hover { filter: brightness(1.08); }
      button:disabled { cursor: wait; opacity: .55; }
      a { background: transparent; color: var(--foreground); }
      button:focus-visible, a:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
      .badge { display: inline-flex; margin-bottom: 14px; padding: 5px 8px; border-radius: 999px; background: var(--accent); color: var(--accent-foreground); font-size: 12px; font-weight: 750; }
      .message { min-height: 24px; margin: 18px 0 0; color: var(--muted); }
      .message.error { color: var(--warning); }
      footer { margin-top: 22px; color: var(--muted); font-size: 13px; line-height: 1.5; }
      @media (max-width: 620px) { .cards { grid-template-columns: 1fr; } .status { align-items: flex-start; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="eyebrow">Systemd runtime</p>
        <h1>OpenChamber</h1>
        <p class="lede">Choose which OpenChamber build is active. OpenCode stays running while the interface switches.</p>
      </header>
      <section class="status" aria-live="polite">
        <div><strong id="selected">Loading runtime status...</strong><small id="detail">Checking services</small></div>
        <span id="indicator" class="indicator" aria-hidden="true"></span>
      </section>
      <section class="cards" aria-label="OpenChamber runtimes">
        ${Object.entries(runtimes).map(([key, runtime]) => `
        <article class="card" data-runtime="${key}">
          <div>
            <span class="badge" hidden>Active</span>
            <h2>${runtime.label}</h2>
            <p>${key === 'regular' ? 'The official upstream OpenChamber release.' : 'The custom fork with the latest fork changes.'}</p>
            <div class="meta">localhost:${runtime.port}</div>
          </div>
          <div class="actions">
            <button type="button" data-switch="${key}">Switch to ${runtime.label}</button>
            <a data-open="${key}" href="http://127.0.0.1:${runtime.port}/" target="_blank" rel="noreferrer" hidden>Open</a>
          </div>
        </article>`).join('')}
      </section>
      <p id="message" class="message" role="status"></p>
      <footer>Only the selected runtime is active. The control page remains available during a switch.</footer>
    </main>
    <script>
      const selected = document.querySelector('#selected');
      const detail = document.querySelector('#detail');
      const indicator = document.querySelector('#indicator');
      const message = document.querySelector('#message');
      const buttons = [...document.querySelectorAll('[data-switch]')];
      const cards = [...document.querySelectorAll('[data-runtime]')];
      const links = [...document.querySelectorAll('[data-open]')];
      const runtimePorts = ${JSON.stringify(Object.fromEntries(Object.entries(runtimes).map(([key, runtime]) => [key, runtime.port])))};

      const runtimeUrl = (runtime) => {
        const host = ${JSON.stringify(runtimeHost)} || window.location.hostname;
        const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
        return protocol + '//' + host + ':' + runtimePorts[runtime] + '/';
      };

      const setBusy = (busy) => {
        buttons.forEach((button) => {
          button.disabled = busy;
          if (busy) button.textContent = 'Switching...';
        });
      };

      const render = (status) => {
        const active = status.selected === 'regular' || status.selected === 'custom' ? status.selected : null;
        selected.textContent = active ? status.runtimes[active].label + ' is active' : 'No runtime is active';
        detail.textContent = status.opencode === 'active' ? 'OpenCode is running' : 'OpenCode is not running';
        indicator.className = 'indicator ' + (active ? 'active' : 'warning');
        cards.forEach((card) => {
          const isActive = card.dataset.runtime === active;
          card.classList.toggle('active', isActive);
          card.querySelector('.badge').hidden = !isActive;
          const button = card.querySelector('[data-switch]');
          button.textContent = isActive ? 'Active' : 'Switch to ' + status.runtimes[card.dataset.runtime].label;
          button.disabled = isActive || status.switching;
        });
        links.forEach((link) => {
          const isActive = link.dataset.open === active;
          link.hidden = !isActive;
          link.href = runtimeUrl(link.dataset.open);
        });
      };

      const readStatus = async () => {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Status request failed');
        return response.json();
      };

      const refresh = async () => {
        try { render(await readStatus()); }
        catch (error) { selected.textContent = 'Status unavailable'; detail.textContent = error.message; indicator.className = 'indicator warning'; }
      };

      buttons.forEach((button) => button.addEventListener('click', async () => {
        const runtime = button.dataset.switch;
        setBusy(true);
        message.className = 'message';
        message.textContent = 'Switching runtime...';
        try {
          const response = await fetch('/api/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime }) });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || 'Runtime switch failed');
          message.textContent = result.message;
          render(result.status);
        } catch (error) {
          message.className = 'message error';
          message.textContent = error.message;
          await refresh();
        } finally { setBusy(false); await refresh(); }
      }));

      void refresh();
      setInterval(() => { if (!buttons.some((button) => button.disabled && button.textContent === 'Switching...')) void refresh(); }, 5000);
    </script>
  </body>
</html>`;

const sendJson = (res, statusCode, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const run = (args, timeoutMs = 60_000) => new Promise((resolve) => {
  const child = spawn(args[0], args.slice(1), { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    finish({ code: null, stdout, stderr: `${stderr}\nCommand timed out.`.trim() });
  }, timeoutMs);
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
  child.on('error', (error) => finish({ code: null, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
  child.on('close', (code) => finish({ code, stdout, stderr }));
});

const parseStatus = (output) => {
  const selected = output.match(/^selected:\s*(\S+)/m)?.[1] || 'none';
  const opencode = output.match(/^opencode:\s*(\S+)/m)?.[1] || 'unknown';
  const result = { selected, opencode, switching: switchInFlight, runtimes: {} };
  for (const [key, runtime] of Object.entries(runtimes)) {
    const state = output.match(new RegExp(`^${key}:\\s*(\\S+)`,'m'))?.[1] || 'unknown';
    result.runtimes[key] = { ...runtime, state, url: `http://127.0.0.1:${runtime.port}/` };
  }
  return result;
};

const getStatus = async () => {
  const result = await run([switchBin, 'status'], 10_000);
  if (result.code !== 0) throw new Error(result.stderr || 'Could not read runtime status');
  return parseStatus(result.stdout);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  let tooLarge = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    if (tooLarge) return;
    body += chunk;
    if (body.length > 4096) {
      tooLarge = true;
      reject(new Error('Request body is too large'));
    }
  });
  req.on('end', () => { if (!tooLarge) resolve(body); });
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && requestUrl.pathname === '/') {
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(controlPage);
      return;
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/status') {
      sendJson(res, 200, await getStatus());
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/switch') {
      if (switchInFlight) {
        sendJson(res, 409, { ok: false, error: 'A runtime switch is already in progress.' });
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { ok: false, error: 'Invalid request body.' }); return; }
      const runtime = body?.runtime;
      if (runtime !== 'regular' && runtime !== 'custom') {
        sendJson(res, 400, { ok: false, error: 'Runtime must be regular or custom.' });
        return;
      }
      switchInFlight = true;
      const result = await run([switchBin, runtime]);
      switchInFlight = false;
      const status = await getStatus();
      if (result.code !== 0) {
        sendJson(res, 502, { ok: false, error: result.stderr || result.stdout || 'Runtime switch failed.', status });
        return;
      }
      sendJson(res, 200, { ok: true, message: result.stdout.trim() || `${runtimes[runtime].label} is active.`, status });
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    switchInFlight = false;
    sendJson(res, 500, { error: error instanceof Error ? error.message : 'Internal control error.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`OpenChamber Tailnet control listening on 127.0.0.1:${port}\n`);
});
