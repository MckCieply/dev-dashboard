import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { GitHubPoller } from '../../src/github/poller.js';
import { GitHubClient, GitHubError } from '../../src/github/client.js';
import { Store } from '../../src/store.js';
import type { Config } from '../../src/config.js';

const load = (f: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));
const NOW = 1_800_000_000_000;
const config: Config = { port: 1, dataDir: '/x', toasts: false, activeDays: 14, pollMs: 30_000, slowPollMs: 120_000, reposRefreshMs: 600_000, orgs: [] };
const rawRepo = (name: string) => ({ full_name: name, pushed_at: new Date(NOW - 1000).toISOString(), archived: false, owner: { login: name.split('/')[0], type: 'User' } });

type Handler = (path: string) => unknown;
function fake(handler: Handler, rate: { remaining: number; limit: number; resetAt: number } | null = { remaining: 4000, limit: 5000, resetAt: 9 }) {
  const calls: string[] = [];
  const client = {
    rest: async (path: string) => { calls.push(path); const r = handler(path); if (r instanceof Error) throw r; return r; },
    graphql: async (q: string) => { calls.push('graphql'); const r = handler('graphql:' + q); if (r instanceof Error) throw r; return r; },
    lastRate: () => rate,
  } as unknown as GitHubClient;
  return { client, calls };
}
const happy: Handler = (p) => {
  if (p.startsWith('/user/repos')) return [rawRepo('acme/app'), rawRepo('acme/other')];
  if (p === '/repos/acme/app/actions/runs?status=queued&per_page=50') return load('runs-queued.json');
  if (p === '/repos/acme/app/actions/runs?status=in_progress&per_page=50') return load('runs-in-progress.json');
  if (p.includes('/actions/runs?')) return { total_count: 0, workflow_runs: [] };
  if (p.includes('/runs/101/jobs')) return load('jobs.json');
  if (p.includes('/runs/99/jobs')) return { total_count: 1, jobs: [{ id: 5, run_id: 99, status: 'in_progress', labels: ['self-hosted'], runner_name: 'win-runner-1', started_at: null }] };
  if (p.includes('/jobs')) return { total_count: 0, jobs: [] };
  if (p === '/repos/acme/app/actions/runners?per_page=100') return load('runners.json');
  if (p.includes('/actions/runners')) return { total_count: 0, runners: [] };
  if (p.startsWith('graphql:')) return load('prs-graphql.json');
  throw new Error('unexpected ' + p);
};
const mk = (client: GitHubClient | null) => {
  const store = new Store({ toasts: false, now: () => NOW });
  const poller = new GitHubPoller({ client, store, config, now: () => NOW });
  return { store, poller };
};

describe('GitHubPoller', () => {
  it('happy path fills store', async () => {
    const { client } = fake(happy);
    const { store, poller } = mk(client);
    await poller.refreshRepos();
    await poller.pollOnce();
    const s = store.get();
    expect(s.repos).toEqual(['acme/app', 'acme/other']);
    expect(s.queue.map((q) => q.id)).toEqual([99, 100, 101]);
    expect(s.runners).toHaveLength(4);
    expect(s.runners.find((r) => r.name === 'win-runner-1')!.job?.runNumber).toBe(41);
    expect(s.prs.length).toBe(4);
    for (const c of ['repos', 'runners', 'queue', 'prs'] as const) {
      expect(s.collectors[c]).toEqual({ ok: true, lastSuccessAt: NOW, error: null });
    }
    expect(s.rate).toEqual({ remaining: 4000, limit: 5000, resetAt: 9, slowed: false });
  });

  it('runners 403 on one repo, ok on another: runners shown, collector ok', async () => {
    const { client } = fake((p) => p === '/repos/acme/other/actions/runners?per_page=100' ? new GitHubError(403, 'forbidden') : happy(p));
    const { store, poller } = mk(client);
    await poller.refreshRepos();
    await poller.pollOnce();
    expect(store.get().runners).toHaveLength(4);
    expect(store.get().collectors.runners.ok).toBe(true);
  });

  it('all runners 401: collector error, previous runners kept', async () => {
    let fail = false;
    const { client } = fake((p) => fail && p.includes('/actions/runners') ? new GitHubError(401, 'x') : happy(p));
    const { store, poller } = mk(client);
    await poller.refreshRepos();
    await poller.pollOnce();
    fail = true;
    await poller.pollOnce();
    expect(store.get().runners).toHaveLength(4);
    expect(store.get().collectors.runners).toMatchObject({ ok: false, error: 'błąd 401', lastSuccessAt: NOW });
    expect(store.get().collectors.queue.ok).toBe(true);
  });

  it('non-GitHubError gives błąd sieci and does not blank other collectors', async () => {
    const { client } = fake((p) => p.startsWith('graphql:') ? new Error('ECONNRESET') : happy(p));
    const { store, poller } = mk(client);
    await poller.refreshRepos();
    await poller.pollOnce();
    expect(store.get().collectors.prs).toMatchObject({ ok: false, error: 'błąd sieci' });
    expect(store.get().runners).toHaveLength(4);
  });

  it('client null: errors on collectors, no calls', async () => {
    const { store, poller } = mk(null);
    await poller.refreshRepos();
    await poller.pollOnce();
    for (const c of ['repos', 'runners', 'queue', 'prs'] as const) {
      expect(store.get().collectors[c]).toMatchObject({ ok: false, error: 'brak tokenu GitHub' });
    }
  });

  it('rate remaining 400 sets slowed', async () => {
    const { client } = fake(happy, { remaining: 400, limit: 5000, resetAt: 9 });
    const { store, poller } = mk(client);
    await poller.refreshRepos();
    await poller.pollOnce();
    expect(store.get().rate).toEqual({ remaining: 400, limit: 5000, resetAt: 9, slowed: true });
  });

  it('null lastRate sets rate null', async () => {
    const { client } = fake(happy, null);
    const { store, poller } = mk(client);
    await poller.refreshRepos();
    await poller.pollOnce();
    expect(store.get().rate).toBeNull();
  });

  it('includes orgs from repos and config for org runners', async () => {
    const { client, calls } = fake((p) => p.startsWith('/user/repos') ? [{ ...rawRepo('org1/app'), owner: { login: 'org1', type: 'Organization' } }] : happy(p));
    const store = new Store({ toasts: false, now: () => NOW });
    const poller = new GitHubPoller({ client, store, config: { ...config, orgs: ['cfgorg'] }, now: () => NOW });
    await poller.refreshRepos();
    await poller.pollOnce();
    expect(calls).toContain('/orgs/org1/actions/runners?per_page=100');
    expect(calls).toContain('/orgs/cfgorg/actions/runners?per_page=100');
  });

  it('no repos: prs ok with empty list and no graphql call', async () => {
    const { client, calls } = fake((p) => p.startsWith('/user/repos') ? [] : happy(p));
    const { store, poller } = mk(client);
    await poller.refreshRepos();
    await poller.pollOnce();
    expect(calls).not.toContain('graphql');
    expect(store.get().collectors.prs.ok).toBe(true);
  });

  it('searches every owner, also for inactive repos, and drops repos the user has no access to', async () => {
    const stale = { ...rawRepo('old/legacy'), pushed_at: new Date(NOW - 90 * 86_400_000).toISOString() };
    const node = (id: string, repo: string) => ({
      id, number: 1, title: id, url: 'u', isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      labels: { nodes: [{ name: 'needs-human' }] }, repository: { nameWithOwner: repo },
    });
    let query = '';
    const { client } = fake((p) => {
      if (p.startsWith('/user/repos')) return [stale];
      if (p.startsWith('graphql:')) {
        query = p;
        const nodes = [node('mine', 'old/legacy'), node('foreign', 'old/public-not-mine')];
        return { s0: { nodes }, m0: { nodes } };
      }
      return happy(p);
    });
    const { store, poller } = mk(client);
    await poller.refreshRepos();
    await poller.pollOnce();
    expect(query).toContain('user:old');
    expect(query).toContain(`merged:>=${new Date(NOW - 86_400_000).toISOString().slice(0, 10)}`);
    expect(store.get().prs.map((p) => [p.id, p.needsHuman])).toEqual([['mine', true]]);
    expect(store.get().merged.map((p) => p.id)).toEqual(['mine']);
  });

  it('start/stop schedule with timers and stop clears them', async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = fake(happy);
      const { poller } = mk(client);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      const n = calls.length;
      expect(n).toBeGreaterThan(0);
      poller.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(calls.length).toBe(n);
    } finally { vi.useRealTimers(); }
  });

  it('goes slow when REST is exhausted even if GraphQL is healthy', async () => {
    const h = (resource: string, rem: number) => ({ 'x-ratelimit-resource': resource, 'x-ratelimit-remaining': String(rem), 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '9' });
    const fetchFn = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/graphql')) return new Response(JSON.stringify({ data: load('prs-graphql.json') }), { status: 200, headers: h('graphql', 4900) });
      if (u.includes('/user/repos')) return new Response(JSON.stringify([rawRepo('acme/app')]), { status: 200, headers: h('core', 300) });
      if (u.includes('/jobs')) return new Response('{"jobs":[]}', { status: 200, headers: h('core', 300) });
      if (u.includes('/actions/runners')) return new Response('{"runners":[]}', { status: 200, headers: h('core', 300) });
      return new Response('{"workflow_runs":[]}', { status: 200, headers: h('core', 300) });
    }) as typeof fetch;
    const client = new GitHubClient({ token: 't', fetch: fetchFn });
    const { store, poller } = mk(client);
    await poller.refreshRepos();
    await poller.pollOnce();
    expect(store.get().rate).toMatchObject({ remaining: 300, slowed: true });
  });

  it('retries repos after 30s when refresh fails, not reposRefreshMs', async () => {
    vi.useFakeTimers();
    try {
      let failRepos = true;
      const { client, calls } = fake((p) => p.startsWith('/user/repos') && failRepos ? new GitHubError(500, 'x') : happy(p));
      const { store, poller } = mk(client);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get().collectors.repos.ok).toBe(false);
      const n = calls.filter((c) => c.startsWith('/user/repos')).length;
      failRepos = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls.filter((c) => c.startsWith('/user/repos')).length).toBe(n + 1);
      expect(store.get().collectors.repos.ok).toBe(true);
      poller.stop();
    } finally { vi.useRealTimers(); }
  });

  it('an unexpected throw in a poll does not stop the loop', async () => {
    vi.useFakeTimers();
    try {
      const { client } = fake(happy);
      const { store, poller } = mk(client);
      const orig = store.setRate.bind(store);
      let thrown = 0;
      store.setRate = (r) => { if (thrown++ === 0) throw new Error('boom'); orig(r); };
      const logs: string[] = [];
      (poller as unknown as { log: (m: string) => void }).log = (m) => logs.push(m);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(thrown).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(thrown).toBe(2);
      expect(store.get().rate).not.toBeNull();
      expect(logs.some((m) => m.includes('boom'))).toBe(true);
      poller.stop();
    } finally { vi.useRealTimers(); }
  });

  it('tolerates null repo entries in graphql data', async () => {
    const data = load('prs-graphql.json') as Record<string, unknown>;
    const { client } = fake((p) => p.startsWith('graphql:') ? { ...data, r1: null } : happy(p));
    const { store, poller } = mk(client);
    await poller.refreshRepos();
    await poller.pollOnce();
    expect(store.get().collectors.prs.ok).toBe(true);
  });
});
