import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../store.js';
import type { HookEvent } from '../types.js';

const MAX_BODY = 1024 * 1024;
const FONT_PKGS = new Set(['jetbrains-mono', 'inter']);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function send(res: http.ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? 'too-large' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveFile(res: http.ServerResponse, root: string, rel: string): void {
  // rel is already URL-decoded
  if (rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return send(res, 404, 'not found');
  const type = TYPES[path.extname(rel).toLowerCase()];
  if (!type) return send(res, 404, 'not found');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return send(res, 404, 'not found');
  fs.readFile(abs, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

export function createServer(opts: { store: Store; publicDir: string; fontsDir: string }): http.Server {
  const { store } = opts;
  const publicDir = path.resolve(opts.publicDir);
  const fontsRoot = path.resolve(opts.fontsDir, '@fontsource');

  const server: http.Server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    // DNS-rebinding / CSRF guard: only answer for our own loopback origin.
    const port = (server.address() as { port: number } | null)?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (port === undefined || !hosts.includes(req.headers.host ?? '')) return send(res, 403, 'forbidden host');
    const origin = req.headers.origin;
    if (method === 'POST' && origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) {
      return send(res, 403, 'forbidden origin');
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return send(res, 404, 'not found');
    }
    // The URL parser normalises "/../" away, so also check the raw path.
    const rawPath = (req.url ?? '').split('?')[0];
    if (pathname.split(/[\\/]/).includes('..') || rawPath.split('/').includes('..')) return send(res, 404, 'not found');

    if (method === 'POST' && pathname === '/hook') {
      if (!/^application\/json(\s*;|$)/i.test((req.headers['content-type'] ?? '').trim())) return send(res, 415, 'content-type must be application/json');
      readBody(req).then((body) => {
        if (body === 'too-large') return send(res, 413, 'payload too large');
        let ev: unknown;
        try { ev = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
        if (!ev || typeof ev !== 'object' || Array.isArray(ev) || typeof (ev as { session_id?: unknown }).session_id !== 'string') {
          return send(res, 400, 'bad payload');
        }
        try { store.applyHook(ev as HookEvent); } catch (e) {
          process.stderr.write(`dev-dashboard: hook failed: ${(e as Error).message}\n`);
        }
        res.writeHead(204);
        res.end();
      }).catch(() => { try { send(res, 400, 'bad request'); } catch { /* ignore */ } });
      return;
    }

    if (method !== 'GET') return send(res, 404, 'not found');

    if (pathname === '/api/state') return send(res, 200, JSON.stringify(store.get()), TYPES['.json']);

    if (pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const write = (): void => { res.write(`event: state\ndata: ${JSON.stringify(store.get())}\n\n`); };
      write();
      const off = store.onChange(write);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); off(); });
      return;
    }

    if (pathname === '/') return serveFile(res, publicDir, 'index.html');

    if (pathname.startsWith('/fonts/')) {
      const rest = pathname.slice('/fonts/'.length);
      const slash = rest.indexOf('/');
      const pkg = slash < 0 ? rest : rest.slice(0, slash);
      if (slash < 0 || !FONT_PKGS.has(pkg)) return send(res, 404, 'not found');
      return serveFile(res, path.join(fontsRoot, pkg), rest.slice(slash + 1));
    }

    return serveFile(res, publicDir, pathname.replace(/^\/+/, ''));
  });
  return server;
}
