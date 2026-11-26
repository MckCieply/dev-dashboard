import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, type App } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import type { DashboardState } from '../../src/types.js';

const load = (f: string): string => fs.readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8');
const json = (body: string): Response => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

const repo = { full_name: 'acme/app', pushed_at: new Date().toISOString(), archived: false, owner: { login: 'acme', type: 'User' } };

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const p = url.pathname + url.search;
  if (p.startsWith('/user/repos')) return json(JSON.stringify([repo]));
  if (p === '/repos/acme/app/actions/runs?status=queued&per_page=50') return json(load('runs-queued.json'));
  if (p === '/repos/acme/app/actions/runs?status=in_progress&per_page=50') return json(load('runs-in-progress.json'));
  if (p.includes('/runs/101/jobs')) return json(load('jobs.json'));
  if (p.includes('/jobs')) return json('{"total_count":0,"jobs":[]}');
  if (p === '/repos/acme/app/actions/runners?per_page=100') return json(load('runners.json'));
  if (p.includes('/actions/runners')) return json('{"total_count":0,"runners":[]}');
  if (url.pathname === '/graphql' && init?.method === 'POST') return json(JSON.stringify({ data: JSON.parse(load('prs-graphql.json')) }));
  return new Response('not found', { status: 404 });
};

const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

const mkConfig = (dataDir: string): Config => ({ port: 0, dataDir, toasts: true, activeDays: 14, pollMs: 30_000, slowPollMs: 120_000, reposRefreshMs: 600_000, orgs: [] });
const state = async (a: App): Promise<DashboardState> => (await fetch(`${a.url}/api/state`)).json() as Promise<DashboardState>;
const hook = (a: App, body: object) => fetch(`${a.url}/hook`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
async function until(fn: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout waiting for condition');
}

describe('smoke', () => {
  it('wires collectors, hooks, toasts, persistence and page', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-e2e-'));
    const calls: { title: string; message: string }[] = [];
    const notify = (o: { title: string; message: string }): void => { calls.push(o); };

    const projectsDir = path.join(dataDir, 'projects');
    fs.mkdirSync(path.join(projectsDir, 'p'), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, 'p', 's1.jsonl'), '{"type":"custom-title","customTitle":"Moja sesja"}\n');

    const a = await startApp({ config: mkConfig(dataDir), token: 'test', fetch: fakeFetch, notify, projectsDir });
    apps.push(a);
    await until(async () => (await state(a)).collectors.prs.ok);
    const st = await state(a);
    expect(st.repos).toEqual(['acme/app']);
    expect(st.runners.length).toBeGreaterThan(0);
    expect(st.prs.length).toBeGreaterThan(0);

    const ev = { session_id: 's1', cwd: '/work/my-proj' };
    expect((await hook(a, { ...ev, hook_event_name: 'UserPromptSubmit', prompt: 'do it' })).status).toBe(204);
    expect(calls).toHaveLength(0);
    expect((await hook(a, { ...ev, hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).status).toBe(204);
    expect(calls).toHaveLength(0); // Claude sessions never toast
    expect((await state(a)).sessions[0].title).toBe('Moja sesja');

    const page = await fetch(`${a.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(fs.readFileSync(path.resolve('public/index.html'), 'utf8'));

    await a.close();
    apps.length = 0;
    expect(fs.existsSync(path.join(dataDir, 'sessions.json'))).toBe(true);

    const b = await startApp({ config: mkConfig(dataDir), token: 'test', fetch: fakeFetch, notify, projectsDir });
    apps.push(b);
    await until(async () => (await state(b)).collectors.prs.ok);
    const st2 = await state(b);
    expect(st2.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(st2.sessions[0].state).toBe('waiting');
    expect(calls).toHaveLength(0); // no toast for restored state
  });

  it('rejects with EADDRINUSE when port is taken', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-e2e-'));
    const a = await startApp({ config: mkConfig(dataDir), token: null });
    apps.push(a);
    const port = Number(new URL(a.url).port);
    await expect(startApp({ config: { ...mkConfig(dataDir), port }, token: null })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
