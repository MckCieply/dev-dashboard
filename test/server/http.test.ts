import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../../src/store.js';
import { createServer } from '../../src/server/http.js';

let server: Server;
let base: string;
let store: Store;

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-root-'));
  fs.writeFileSync(path.join(root, 'secret.json'), '{"secret":true}');
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>stub</h1>');
  fs.writeFileSync(path.join(publicDir, 'app.js'), 'x');
  store = new Store({ toasts: true });
  server = createServer({ store, publicDir, fontsDir: path.resolve('node_modules') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const post = (body: string) => fetch(`${base}/hook`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });

describe('http', () => {
  it('POST valid hook -> 204 and state shows session', async () => {
    const r = await post(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/a/proj', prompt: 'x' }));
    expect(r.status).toBe(204);
    const st = await (await fetch(`${base}/api/state`)).json();
    expect(st.sessions.map((s: { id: string }) => s.id)).toEqual(['s1']);
  });

  it('POST /hook without application/json content-type -> 415', async () => {
    const body = JSON.stringify({ hook_event_name: 'Stop', session_id: 'x1' });
    expect((await fetch(`${base}/hook`, { method: 'POST', body, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await fetch(`${base}/hook`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    expect((await fetch(`${base}/hook`, { method: 'POST', body, headers: { 'content-type': 'application/json; charset=utf-8' } })).status).toBe(204);
    expect(store.get().sessions.map((s) => s.id)).toEqual(['x1']);
  });

  it('rejects foreign Host headers with 403, accepts localhost/127.0.0.1/[::1]', async () => {
    const port = new URL(base).port;
    const get = (host: string) => new Promise<number>((resolve, reject) => {
      const rq = httpRequest({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: host } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
      rq.on('error', reject); rq.end();
    });
    expect(await get('evil.example.com')).toBe(403);
    expect(await get(`evil.example.com:${port}`)).toBe(403);
    expect(await get('127.0.0.1:1')).toBe(403);
    expect(await get(`127.0.0.1:${port}`)).toBe(200);
    expect(await get(`localhost:${port}`)).toBe(200);
    expect(await get(`[::1]:${port}`)).toBe(200);
  });

  it('POST with foreign Origin -> 403, same-origin Origin ok', async () => {
    const port = new URL(base).port;
    const body = JSON.stringify({ hook_event_name: 'Stop', session_id: 'o1' });
    const p = (origin: string) => fetch(`${base}/hook`, { method: 'POST', body, headers: { 'content-type': 'application/json', origin } });
    expect((await p('http://evil.example.com')).status).toBe(403);
    expect((await p(`http://127.0.0.1:${port}.evil.com`)).status).toBe(403);
    expect((await p(`http://localhost:${port}`)).status).toBe(204);
    expect((await p(`http://127.0.0.1:${port}`)).status).toBe(204);
  });

  it('bad JSON -> 400, state unchanged', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post('[1]')).status).toBe(400);
    expect((await post(JSON.stringify({ hook_event_name: 'Stop' }))).status).toBe(400);
    const st = await (await fetch(`${base}/api/state`)).json();
    expect(st.sessions).toEqual([]);
  });

  it('body over 1 MB -> 413', async () => {
    const r = await post(JSON.stringify({ session_id: 'a', pad: 'x'.repeat(1_100_000) }));
    expect(r.status).toBe(413);
  });

  it('SSE sends state on connect and on change', async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (pred: (b: string) => boolean) => {
      while (!pred(buf)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
    };
    await until((b) => b.includes('event: state') && b.endsWith('\n\n'));
    expect(buf).toContain('event: state');
    expect(buf).not.toContain('sse-sess');
    await post(JSON.stringify({ hook_event_name: 'Stop', session_id: 'sse-sess', cwd: '/x/y' }));
    await until((b) => b.includes('sse-sess'));
    expect(buf).toContain('sse-sess');
    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('path traversal -> 404', async () => {
    for (const p of ['/../secret.json', '/..%2fsecret.json', '/%2e%2e%2fsecret.json', '/%2e%2e/secret.json', '/fonts/inter/..%2f..%2f..%2f..%2fsecret.json', '/fonts/inter/../../../secret.json']) {
      const r = await fetch(base + p);
      expect(r.status, p).toBe(404);
    }
    // raw (non-normalised) request
    const net = await import('node:net');
    const port = (server.address() as AddressInfo).port;
    const raw = await new Promise<string>((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => c.write(`GET /../secret.json HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
      let d = ''; c.on('data', (x) => (d += x)); c.on('close', () => resolve(d));
    });
    expect(raw.startsWith('HTTP/1.1 404')).toBe(true);
  });

  it('serves / and static files, 404 for unknown', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/nope.css`)).status).toBe(404);
    expect((await fetch(`${base}/fonts/other/x.css`)).status).toBe(404);
    expect((await fetch(`${base}/api/state`, { method: 'POST' })).status).toBe(404);
  });

  it('serves fonts from node_modules', async () => {
    const r = await fetch(`${base}/fonts/inter/900.css`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/css');
  });
});
