import { describe, it, expect } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SCRIPT = path.resolve('hooks/report.mjs');

function startServer(handler) {
  const bodies = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { bodies.push(b); handler(req, res); });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/hook`,
    bodies,
    close: () => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)); },
  })));
}

function run(stdin, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, CLAUDE_CODE_REMOTE: '', ...env } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    p.stdin.end(stdin);
  });
}

const ok = (_req, res) => { res.statusCode = 204; res.end(); };

describe('hooks/report.mjs', () => {
  it('posts payload with dd_where lokalna', async () => {
    const s = await startServer(ok);
    const r = await run(JSON.stringify({ session_id: 'a' }), { DEV_DASHBOARD_URL: s.url });
    await s.close();
    expect(r.code).toBe(0);
    expect(JSON.parse(s.bodies[0])).toEqual({ session_id: 'a', dd_where: 'lokalna' });
  });

  it('uses chmura when CLAUDE_CODE_REMOTE=true', async () => {
    const s = await startServer(ok);
    await run(JSON.stringify({ session_id: 'a' }), { DEV_DASHBOARD_URL: s.url, CLAUDE_CODE_REMOTE: 'true' });
    await s.close();
    expect(JSON.parse(s.bodies[0]).dd_where).toBe('chmura');
  });

  it('exits 0 quietly when the port is closed', async () => {
    const s = await startServer(ok);
    const url = s.url;
    await s.close();
    const r = await run(JSON.stringify({ session_id: 'a' }), { DEV_DASHBOARD_URL: url });
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(3000);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('exits 0 within 3 s when the server never answers', async () => {
    const s = await startServer(() => {});
    const r = await run(JSON.stringify({ session_id: 'a' }), { DEV_DASHBOARD_URL: s.url });
    await s.close();
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(3000);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  }, 10000);

  it('exits 0 and sends nothing on invalid stdin', async () => {
    const s = await startServer(ok);
    const r = await run('not json{', { DEV_DASHBOARD_URL: s.url });
    await s.close();
    expect(r.code).toBe(0);
    expect(s.bodies).toEqual([]);
    expect(r.stdout + r.stderr).toBe('');
  });
});
