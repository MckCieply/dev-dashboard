import { describe, expect, it } from 'vitest';
import { createAlertEngine } from '../../src/notify/rules.js';
import type { DashboardState, PullRequest, Runner, Session } from '../../src/types.js';

const ok = { ok: true, lastSuccessAt: null, error: null };
function st(p: Partial<DashboardState> = {}): DashboardState {
  return {
    sessions: [], runners: [], queue: [], prs: [], repos: [],
    collectors: { sessions: { ...ok }, repos: { ...ok }, runners: { ...ok }, queue: { ...ok }, prs: { ...ok } },
    rate: null, toasts: true, now: 0, ...p,
  };
}
const sess = (o: Partial<Session> = {}): Session => ({
  id: 's1', project: 'proj', cwd: '/x/proj', task: 'do it', where: 'lokalna', state: 'working',
  detail: 'Potrzebuje zgody', since: 1000, lastEventAt: 1000, ...o,
});
const runner = (o: Partial<Runner> = {}): Runner => ({ id: 1, name: 'r1', os: 'Windows', labels: [], state: 'idle', job: null, ...o });
const pr = (o: Partial<PullRequest> = {}): PullRequest => ({
  id: 'p1', repo: 'o/r', number: 7, title: 'Fix', url: 'u', draft: false,
  checks: { state: 'pending', passed: 0, failed: 0, total: 1 }, review: 'none', merge: 'blocked', ...o,
});
function polled(runners: Runner[], at: number, extra: Partial<DashboardState> = {}): DashboardState {
  const s = st({ runners, ...extra });
  s.collectors.runners = { ok: true, lastSuccessAt: at, error: null };
  return s;
}

describe('sessions', () => {
  it('alerts working -> waiting', () => {
    const e = createAlertEngine();
    const a = e.evaluate(st({ sessions: [sess({ state: 'waiting' })] }), st({ sessions: [sess()] }));
    expect(a).toHaveLength(1);
    expect(a[0].title).toBe('Czeka: proj');
    expect(a[0].message).toBe('Potrzebuje zgody · do it');
  });
  it('omits task separator when task empty', () => {
    const a = createAlertEngine().evaluate(st({ sessions: [sess({ state: 'waiting', task: '' })] }), st({ sessions: [sess()] }));
    expect(a[0].message).toBe('Potrzebuje zgody');
  });
  it('no alert waiting -> waiting', () => {
    const w = sess({ state: 'waiting' });
    expect(createAlertEngine().evaluate(st({ sessions: [{ ...w, detail: 'x' }] }), st({ sessions: [w] }))).toEqual([]);
  });
  it('no alert for new waiting session', () => {
    expect(createAlertEngine().evaluate(st({ sessions: [sess({ state: 'waiting' })] }), st())).toEqual([]);
  });
  it('no alert working -> unknown (also a sweep of many)', () => {
    const prev = st({ sessions: [sess(), sess({ id: 's2' }), sess({ id: 's3' })] });
    const next = st({ sessions: prev.sessions.map((s) => ({ ...s, state: 'unknown' as const })) });
    expect(createAlertEngine().evaluate(next, prev)).toEqual([]);
  });
  it('restart: fresh engine with identical restored state gives no alerts', () => {
    const s = st({ sessions: [sess({ state: 'waiting' })], runners: [runner({ state: 'offline' })] });
    s.collectors.runners.lastSuccessAt = 5;
    expect(createAlertEngine().evaluate(s, s)).toEqual([]);
  });
});

describe('runners', () => {
  it('offline: none after 1 poll, one after 2, none extra after 3', () => {
    const e = createAlertEngine();
    let prev = polled([runner()], 1);
    expect(e.evaluate(prev, st())).toEqual([]); // baseline
    const offline = (t: number) => polled([runner({ state: 'offline' })], t);
    let n = offline(2);
    expect(e.evaluate(n, prev)).toEqual([]);
    prev = n; n = offline(3);
    const a = e.evaluate(n, prev);
    expect(a).toHaveLength(1);
    expect(a[0].title).toBe('Runner offline: r1');
    expect(a[0].message).toBe('Windows');
    prev = n; n = offline(4);
    expect(e.evaluate(n, prev)).toEqual([]);
  });
  it('offline -> online alerts', () => {
    const e = createAlertEngine();
    const s = [polled([runner()], 1), polled([runner({ state: 'offline' })], 2), polled([runner({ state: 'offline' })], 3), polled([runner()], 4)];
    e.evaluate(s[0], st());
    e.evaluate(s[1], s[0]);
    e.evaluate(s[2], s[1]);
    const a = e.evaluate(s[3], s[2]);
    expect(a.map((x) => x.title)).toEqual(['Runner znowu online: r1']);
  });
  it('offline at baseline: silent until online, then online alert', () => {
    const e = createAlertEngine();
    const s = [0, 1, 2, 3].map((i) => polled([runner({ state: 'offline' })], i + 1));
    expect(e.evaluate(s[0], st())).toEqual([]);
    expect(e.evaluate(s[1], s[0])).toEqual([]);
    expect(e.evaluate(s[2], s[1])).toEqual([]);
    expect(e.evaluate(s[3], s[2])).toEqual([]);
    const on = polled([runner()], 5);
    expect(e.evaluate(on, s[3]).map((x) => x.title)).toEqual(['Runner znowu online: r1']);
  });
  it('same lastSuccessAt twice does not advance streak', () => {
    const e = createAlertEngine();
    const base = polled([runner()], 1);
    e.evaluate(base, st());
    const p2 = polled([runner({ state: 'offline' })], 2);
    e.evaluate(p2, base);
    expect(e.evaluate(polled([runner({ state: 'offline' })], 2), p2)).toEqual([]);
    expect(e.evaluate(polled([runner({ state: 'offline' })], 2), p2)).toEqual([]);
  });
  it('unrelated store changes between polls do not advance streak', () => {
    const e = createAlertEngine();
    const base = polled([runner()], 1);
    e.evaluate(base, st());
    const p2 = polled([runner({ state: 'offline' })], 2);
    e.evaluate(p2, base);
    const hook = polled([runner({ state: 'offline' })], 2, { sessions: [sess()] });
    expect(e.evaluate(hook, p2)).toEqual([]);
    const colls = polled([runner({ state: 'offline' })], 2, { sessions: [sess()] });
    colls.collectors.prs = { ok: true, lastSuccessAt: 9, error: null };
    expect(e.evaluate(colls, hook)).toEqual([]);
    const p3 = polled([runner({ state: 'offline' })], 3, { sessions: [sess()] });
    expect(e.evaluate(p3, colls)).toHaveLength(1);
  });
});

describe('prs', () => {
  const failing = pr({ checks: { state: 'fail', passed: 0, failed: 1, total: 1 } });
  it('alerts checks -> fail once', () => {
    const e = createAlertEngine();
    const a = e.evaluate(st({ prs: [failing] }), st({ prs: [pr()] }));
    expect(a).toHaveLength(1);
    expect(a[0].title).toBe('Checki nie przeszły: o/r #7');
    expect(a[0].message).toBe('Fix');
    expect(e.evaluate(st({ prs: [failing] }), st({ prs: [pr()] }))).toEqual([]); // same key in a row
  });
  it('alerts merge -> ready', () => {
    const a = createAlertEngine().evaluate(st({ prs: [pr({ merge: 'ready' })] }), st({ prs: [pr()] }));
    expect(a.map((x) => x.title)).toEqual(['Gotowy do merge: o/r #7']);
  });
  it('no alert for new PR', () => {
    expect(createAlertEngine().evaluate(st({ prs: [failing] }), st())).toEqual([]);
  });
});
