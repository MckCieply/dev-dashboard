import { describe, expect, it } from 'vitest';
import { createAlertEngine } from '../../src/notify/rules.js';
import type { DashboardState, PullRequest, Runner, Session } from '../../src/types.js';

const ok = { ok: true, lastSuccessAt: null, error: null };
function st(p: Partial<DashboardState> = {}): DashboardState {
  return {
    sessions: [], runners: [], queue: [], prs: [], merged: [], repos: [],
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
  checks: { state: 'pending', passed: 0, failed: 0, total: 1 }, review: 'none', merge: 'blocked', labels: [], needsHuman: false, ...o,
});
function polled(runners: Runner[], at: number, extra: Partial<DashboardState> = {}): DashboardState {
  const s = st({ runners, ...extra });
  s.collectors.runners = { ok: true, lastSuccessAt: at, error: null };
  return s;
}

describe('sessions (Claude toasts are off)', () => {
  it.each(['prośba o zgodę: Bash', 'odpowiedź gotowa', 'czeka na odpowiedź'])('no alert for a session waiting: %s', (detail) => {
    const e = createAlertEngine();
    e.evaluate(st(), st());
    expect(e.evaluate(st({ sessions: [sess({ state: 'waiting', detail })] }), st({ sessions: [sess()] }))).toEqual([]);
    expect(e.evaluate(st({ sessions: [sess({ id: 's2', state: 'waiting', detail })] }), st())).toEqual([]);
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
  });
  it('repeated fail -> pass -> fail alerts twice', () => {
    const e = createAlertEngine();
    const pass = pr({ checks: { state: 'pass', passed: 1, failed: 0, total: 1 } });
    expect(e.evaluate(st({ prs: [failing] }), st({ prs: [pr()] }))).toHaveLength(1);
    expect(e.evaluate(st({ prs: [pass] }), st({ prs: [failing] }))).toEqual([]);
    expect(e.evaluate(st({ prs: [failing] }), st({ prs: [pass] }))).toHaveLength(1);
  });
  it('repeated ready -> blocked -> ready alerts twice', () => {
    const e = createAlertEngine();
    const ready = pr({ merge: 'ready' });
    expect(e.evaluate(st({ prs: [ready] }), st({ prs: [pr()] }))).toHaveLength(1);
    expect(e.evaluate(st({ prs: [pr()] }), st({ prs: [ready] }))).toEqual([]);
    expect(e.evaluate(st({ prs: [ready] }), st({ prs: [pr()] }))).toHaveLength(1);
  });
  it('alerts merge -> ready', () => {
    const a = createAlertEngine().evaluate(st({ prs: [pr({ merge: 'ready' })] }), st({ prs: [pr()] }));
    expect(a.map((x) => x.title)).toEqual(['Gotowy do merge: o/r #7']);
  });
  it('no alert for new PR', () => {
    expect(createAlertEngine().evaluate(st({ prs: [failing] }), st())).toEqual([]);
  });
});

describe('needs-human', () => {
  const human = pr({ needsHuman: true, labels: ['needs-human'] });
  const polledPrs = (prs: PullRequest[]) => {
    const s = st({ prs });
    s.collectors.prs = { ok: true, lastSuccessAt: 1, error: null };
    return s;
  };
  it('silent for PRs that already need a human at the first poll', () => {
    const e = createAlertEngine();
    expect(e.evaluate(st({ prs: [human] }), st())).toEqual([]);
    expect(e.evaluate(polledPrs([human]), st({ prs: [human] }))).toEqual([]);
  });
  it('alerts once when a known PR starts to need a human', () => {
    const e = createAlertEngine();
    e.evaluate(polledPrs([pr()]), st());
    const a = e.evaluate(polledPrs([human]), polledPrs([pr()]));
    expect(a.map((x) => [x.title, x.message])).toEqual([['Wymaga człowieka: o/r #7', 'Fix']]);
    expect(e.evaluate(polledPrs([human]), polledPrs([human]))).toEqual([]);
  });
  it('alerts a new PR after an empty first poll', () => {
    const e = createAlertEngine();
    e.evaluate(polledPrs([]), st());
    expect(e.evaluate(polledPrs([human]), polledPrs([]))).toHaveLength(1);
  });
  it('startup events before the first PR poll do not count as the first poll', () => {
    const e = createAlertEngine();
    e.evaluate(st({ sessions: [sess()] }), st());
    expect(e.evaluate(st({ prs: [human] }), st())).toEqual([]);
  });
  it('alerts again after the label was cleared and returned', () => {
    const e = createAlertEngine();
    e.evaluate(polledPrs([human]), st());
    e.evaluate(polledPrs([pr()]), polledPrs([human]));
    expect(e.evaluate(polledPrs([human]), polledPrs([pr()]))).toHaveLength(1);
  });
});
describe('merged', () => {
  const m = (id: string, number = 7) => ({ id, repo: 'o/r', number, title: 'Fix' });
  const polledMerged = (merged: ReturnType<typeof m>[]) => {
    const s = st({ merged });
    s.collectors.prs = { ok: true, lastSuccessAt: 1, error: null };
    return s;
  };
  it('silent for PRs merged before the first poll', () => {
    const e = createAlertEngine();
    expect(e.evaluate(st({ merged: [m('a')] }), st())).toEqual([]);
    expect(e.evaluate(polledMerged([m('a')]), st())).toEqual([]);
  });
  it('alerts each newly merged PR once, even after it leaves and returns to the list', () => {
    const e = createAlertEngine();
    e.evaluate(polledMerged([]), st());
    const a = e.evaluate(polledMerged([m('a')]), polledMerged([]));
    expect(a.map((x) => [x.kind, x.title, x.message])).toEqual([['merged', 'Zmergowany: o/r #7', 'Fix']]);
    e.evaluate(polledMerged([]), polledMerged([m('a')]));
    expect(e.evaluate(polledMerged([m('a')]), polledMerged([]))).toEqual([]);
  });
});

describe('alert kinds', () => {
  const polled2 = (o: object, stamp: number) => {
    const s = st(o);
    s.collectors.prs = { ok: true, lastSuccessAt: stamp, error: null };
    s.collectors.runners = { ok: true, lastSuccessAt: stamp, error: null };
    return s;
  };
  it('every alert carries the kind that picks its icon', () => {
    const e = createAlertEngine();
    const a = polled2({ prs: [pr()], runners: [runner()] }, 1);
    const b = polled2({ prs: [pr({ checks: { state: 'fail', passed: 0, failed: 1, total: 1 } })], runners: [runner({ state: 'offline' })] }, 2);
    const c = polled2({ prs: [pr({ merge: 'ready', needsHuman: true })], runners: [runner({ state: 'offline' })] }, 3);
    const d = polled2({ prs: [], runners: [runner()] }, 4);
    e.evaluate(a, st());
    const kinds = [...e.evaluate(b, a), ...e.evaluate(c, b), ...e.evaluate(d, c)].map((x) => x.kind);
    expect(kinds.sort()).toEqual(['checks-failed', 'needs-human', 'ready', 'runner-offline', 'runner-online']);
  });
});