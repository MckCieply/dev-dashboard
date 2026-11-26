import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  esc, fmtDuration, fmtClock, renderHeader, renderWaiting, renderTiles, renderSessions,
  renderRunners, renderQueue, renderPrs, renderFooter, collectorError, waitingCount, faviconFor,
} from '../../public/render.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const okC = { ok: true, lastSuccessAt: NOW - 5000, error: null };

function state(over = {}) {
  return {
    sessions: [], runners: [], queue: [], prs: [], repos: [],
    collectors: { sessions: okC, repos: okC, runners: okC, queue: okC, prs: okC },
    rate: { remaining: 4812, limit: 5000, resetAt: NOW + 10 * MIN, slowed: false },
    toasts: true, now: NOW, ...over,
  };
}
const sess = (o) => ({
  id: 'a', project: 'proj', cwd: '/x/proj', task: 'task', where: 'lokalna', state: 'working',
  detail: 'edycja', since: NOW - 5 * MIN, lastEventAt: NOW - MIN, ...o,
});
const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

describe('esc', () => {
  it('escapes & < > " \'', () => {
    expect(esc('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });
  it('coerces non-strings', () => {
    expect(esc(5)).toBe('5');
    expect(esc(null)).toBe('');
  });
});

describe('fmtDuration', () => {
  it('boundaries', () => {
    expect(fmtDuration(59_000)).toBe('teraz');
    expect(fmtDuration(60_000)).toBe('1 min');
    expect(fmtDuration(59 * MIN)).toBe('59 min');
    expect(fmtDuration(60 * MIN)).toBe('1 h 0 min');
    expect(fmtDuration(90 * MIN)).toBe('1 h 30 min');
    expect(fmtDuration(25 * 60 * MIN)).toBe('1 d');
    expect(fmtDuration(-5)).toBe('teraz');
  });
});

describe('fmtClock', () => {
  it('formats local HH:MM', () => {
    expect(fmtClock(NOW)).toBe(hhmm(NOW));
    expect(fmtClock(NOW)).toMatch(/^\d\d:\d\d$/);
  });
});

describe('XSS', () => {
  const evil = '<img src=x onerror=alert(1)>&';
  it('escapes task in renderSessions', () => {
    const html = renderSessions(state({ sessions: [sess({ task: evil, project: '<b>p</b>', detail: '<i>' })] }), NOW);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>p');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&amp;');
  });
  it('escapes task in renderWaiting', () => {
    const html = renderWaiting(state({ sessions: [sess({ state: 'waiting', task: evil, detail: '<script>' })] }), NOW);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
  });
  it('escapes PR titles, runner names and queue fields', () => {
    const pr = {
      id: '1', repo: 'o/<r>', number: 1, title: '<script>x</script> & y', url: 'https://x/1', draft: false,
      checks: { state: 'pass', passed: 1, failed: 0, total: 1 }, review: 'approved', merge: 'ready',
    };
    expect(renderPrs(state({ prs: [pr] }))).not.toContain('<script>');
    const rn = { id: 1, name: '<u>n</u>', os: 'Linux', labels: [], state: 'idle', job: null };
    expect(renderRunners(state({ runners: [rn] }), NOW)).not.toContain('<u>');
    const q = {
      id: 1, repo: 'r', workflow: '<w>', runNumber: 1, branch: '<br>', state: 'queued', createdAt: NOW, startedAt: null,
      labels: ['<l>'], runnerName: null, url: 'u',
    };
    const html = renderQueue(state({ queue: [q] }), NOW);
    expect(html).not.toContain('<w>');
    expect(html).not.toContain('<l>');
  });
  it('escapes the collector error', () => {
    const html = collectorError({ ok: false, lastSuccessAt: NOW, error: '<b>x' }, 'GitHub');
    expect(html).not.toContain('<b>');
  });
  it('does not allow javascript: PR links', () => {
    const pr = {
      id: '1', repo: 'r', number: 1, title: 't', url: 'javascript:alert(1)', draft: false,
      checks: { state: 'none', passed: 0, failed: 0, total: 0 }, review: 'none', merge: 'unknown',
    };
    expect(renderPrs(state({ prs: [pr] }))).not.toContain('javascript:');
  });
});

describe('renderWaiting', () => {
  it('calm block with no alert class at 0', () => {
    const html = renderWaiting(state({ sessions: [sess()] }), NOW);
    expect(html).toContain('Nic nie czeka');
    expect(html).not.toContain('alert');
    expect(html).toContain('aria-live="polite"');
  });
  it('red block at 3, oldest first', () => {
    const sessions = [
      sess({ id: '1', task: 'newer', state: 'waiting', since: NOW - 4 * MIN }),
      sess({ id: '2', task: 'oldest', state: 'waiting', since: NOW - 27 * MIN }),
      sess({ id: '3', task: 'middle', state: 'waiting', since: NOW - 12 * MIN }),
      sess({ id: '4', task: 'busy', state: 'working' }),
    ];
    const html = renderWaiting(state({ sessions }), NOW);
    expect(html).toContain('is-alert');
    expect(html).toContain('>03<');
    expect(html).not.toContain('busy');
    expect(html.indexOf('oldest')).toBeLessThan(html.indexOf('middle'));
    expect(html.indexOf('middle')).toBeLessThan(html.indexOf('newer'));
    expect(html).toContain('27 min');
  });
});

describe('status labels', () => {
  it('sessions', () => {
    const html = renderSessions(state({
      sessions: [sess({ id: '1', state: 'waiting' }), sess({ id: '2', state: 'working' }), sess({ id: '3', state: 'unknown' })],
    }), NOW);
    for (const l of ['[CZEKA]', '[PRACUJE]', '[NIEZNANY]']) expect(html).toContain(l);
    expect(html).toContain('aria-hidden="true"');
  });
  it('runners and details', () => {
    const job = { repo: 'Toviq', workflow: 'ci.yml', runNumber: 482, startedAt: NOW - 6 * MIN };
    const runners = [
      { id: 1, name: 'a', os: 'Windows', labels: [], state: 'busy', job },
      { id: 2, name: 'b', os: 'Linux', labels: [], state: 'idle', job: null },
      { id: 3, name: 'c', os: 'Linux', labels: [], state: 'offline', job: null },
    ];
    const html = renderRunners(state({ runners }), NOW);
    for (const l of ['[ZAJĘTY]', '[WOLNY]', '[OFFLINE]']) expect(html).toContain(l);
    expect(html).toContain('Toviq · ci.yml #482 · 6 min');
    expect(html).toContain('wolny');
  });
  it('queue labels and details', () => {
    const base = { id: 1, repo: 'Toviq', workflow: 'ci.yml', runNumber: 1, branch: 'main', url: 'u' };
    const queue = [
      { ...base, state: 'in_progress', createdAt: NOW - 8 * MIN, startedAt: NOW - 6 * MIN, labels: [], runnerName: 'win-1' },
      { ...base, id: 2, state: 'queued', createdAt: NOW - 4 * MIN, startedAt: null, labels: ['windows', 'x64'], runnerName: null },
    ];
    const html = renderQueue(state({ queue }), NOW);
    expect(html).toContain('[W TRAKCIE]');
    expect(html).toContain('[W KOLEJCE]');
    expect(html).toContain('6 min · win-1');
    expect(html).toContain('czeka 4 min · potrzebuje: windows, x64');
  });
});

describe('renderPrs', () => {
  const mk = (merge, checks, review) => ({
    id: merge, repo: 'Toviq', number: 214, title: 'T', url: 'https://github.com/x/y/pull/214', draft: false, checks, review, merge,
  });
  it('merge tags', () => {
    const c = { state: 'pass', passed: 1, failed: 0, total: 1 };
    const prs = ['ready', 'blocked', 'conflict', 'draft', 'unknown'].map((m) => mk(m, c, 'none'));
    const html = renderPrs(state({ prs }));
    for (const l of ['[GOTOWY]', '[ZABLOKOWANY]', '[KONFLIKT]', '[DRAFT]', '[?]']) expect(html).toContain(l);
  });
  it('checks and review text, link', () => {
    const html = renderPrs(state({
      prs: [
        mk('blocked', { state: 'fail', passed: 5, failed: 1, total: 6 }, 'changes_requested'),
        mk('ready', { state: 'pass', passed: 6, failed: 0, total: 6 }, 'approved'),
        mk('draft', { state: 'pending', passed: 2, failed: 0, total: 5 }, 'review_required'),
        mk('unknown', { state: 'none', passed: 0, failed: 0, total: 0 }, 'draft'),
        mk('unknown', { state: 'none', passed: 0, failed: 0, total: 0 }, 'none'),
      ],
    }));
    for (const t of ['1 z 6 nie przeszło', '6 z 6 OK', 'w toku, 2 z 5', 'brak checków',
      'prośba o zmiany', 'zatwierdzony', 'czeka na review', 'draft', 'bez review']) expect(html).toContain(t);
    expect(html).toContain('Toviq #214 / T');
    expect(html).toContain('href="https://github.com/x/y/pull/214"');
    expect(html).toContain('target="_blank" rel="noopener"');
  });
});

describe('empty states', () => {
  it('shows Polish empty text', () => {
    const s = state();
    expect(renderSessions(s, NOW)).toContain('Brak sesji');
    expect(renderRunners(s, NOW)).toContain('Brak runnerów');
    expect(renderQueue(s, NOW)).toContain('Kolejka pusta');
    expect(renderPrs(s)).toContain('Brak otwartych PR');
  });
});

describe('stale data', () => {
  const bad = { ok: false, lastSuccessAt: NOW - MIN, error: 'błąd 500' };
  it('marks a panel is-stale when collector failed but rows exist', () => {
    const r = { id: 1, name: 'r1', os: 'Linux', labels: [], state: 'idle', job: null };
    const html = renderRunners(state({ runners: [r], collectors: { ...state().collectors, runners: bad } }), NOW);
    expect(html).toContain('is-stale');
    expect(html).toContain('r1');
  });
  it('no is-stale when healthy or when no rows', () => {
    const r = { id: 1, name: 'r1', os: 'Linux', labels: [], state: 'idle', job: null };
    expect(renderRunners(state({ runners: [r] }), NOW)).not.toContain('is-stale');
    expect(renderRunners(state({ collectors: { ...state().collectors, runners: bad } }), NOW)).not.toContain('is-stale');
  });
});

describe('collectorError', () => {
  it('with data time', () => {
    const html = collectorError({ ok: false, lastSuccessAt: NOW, error: 'błąd 401' }, 'GitHub');
    expect(html).toContain(`GitHub: błąd 401, dane z ${hhmm(NOW)}`);
    expect(html).toContain('class="err"');
  });
  it('without data', () => {
    expect(collectorError({ ok: false, lastSuccessAt: null, error: 'błąd 401' }, 'GitHub')).toContain('GitHub: błąd 401, brak danych');
  });
  it('empty when ok or never run', () => {
    expect(collectorError(okC, 'GitHub')).toBe('');
    expect(collectorError({ ok: false, lastSuccessAt: null, error: null }, 'GitHub')).toBe('');
  });
  it('panels show it above rows', () => {
    const c = { ok: false, lastSuccessAt: NOW, error: 'błąd 403' };
    const s = state({ collectors: { ...state().collectors, runners: c } });
    expect(renderRunners(s, NOW)).toContain('Runnery: błąd 403');
    expect(renderHeader(s, NOW, true)).not.toContain('błąd 403');
    const h = renderHeader(state({ collectors: { ...state().collectors, repos: c } }), NOW, true);
    expect(h).toContain('błąd 403');
  });
});

describe('renderHeader', () => {
  it('LIVE when connected, ROZŁĄCZONO otherwise', () => {
    const on = renderHeader(state(), NOW, true);
    expect(on).toContain('LIVE');
    expect(on).not.toContain('ROZŁĄCZONO');
    expect(on).toContain('GH_API 4812/5000');
    expect(on).toContain('TOAST ON');
    const off = renderHeader(state({ toasts: false }), NOW, false);
    expect(off).toContain('[ROZŁĄCZONO]');
    expect(off).not.toContain('LIVE');
    expect(off).toContain('TOAST OFF');
  });
  it('SYNC uses max lastSuccessAt, dash when none', () => {
    const t = new Date(2026, 10, 26, 14, 32, 5).getTime();
    const c = (ts) => ({ ok: true, lastSuccessAt: ts, error: null });
    const s = state({ collectors: { sessions: c(t - 9000), repos: c(null), runners: c(t), queue: c(t - 1000), prs: c(null) } });
    expect(renderHeader(s, NOW, true)).toContain('SYNC 14:32:05');
    const none = c(null);
    expect(renderHeader(state({ collectors: { sessions: none, repos: none, runners: none, queue: none, prs: none }, rate: null }), NOW, true))
      .toContain('SYNC —');
  });
});

describe('renderTiles', () => {
  it('counts', () => {
    const job = { repo: 'r', workflow: 'w', runNumber: 1, startedAt: NOW };
    const s = state({
      sessions: [sess({ id: '1', state: 'waiting' }), sess({ id: '2' }), sess({ id: '3' }), sess({ id: '4', state: 'unknown' })],
      runners: [
        { id: 1, name: 'a', os: 'x', labels: [], state: 'busy', job },
        { id: 2, name: 'b', os: 'x', labels: [], state: 'idle', job: null },
        { id: 3, name: 'c', os: 'x', labels: [], state: 'offline', job: null },
      ],
    });
    const html = renderTiles(s);
    expect(html).toContain('>04<');
    expect(html).toContain('2 PRACUJE');
    expect(html).toContain('2/3');
    expect(html).toContain('1 ZAJĘTY');
    expect(html).toContain('1 OFFLINE');
    expect(html).toContain('Pull requesty');
  });
});

describe('renderFooter', () => {
  it('note only when slowed', () => {
    expect(renderFooter(state())).not.toContain('Limit GitHub');
    const resetAt = new Date(2026, 10, 26, 15, 4).getTime();
    const html = renderFooter(state({ rate: { remaining: 400, limit: 5000, resetAt, slowed: true } }));
    expect(html).toContain('Limit GitHub niski: odświeżanie co 2 min do 15:04');
  });
  it('no rate, no note', () => {
    expect(renderFooter(state({ rate: null }))).not.toContain('Limit GitHub');
  });
});


describe('color coding', () => {
  const row = (html) => html.match(/class="(?:row|pr)(?: [^"]*)?"/g);
  it('sessions get a row tone and a colored tag', () => {
    const html = renderSessions(state({
      sessions: [sess({ id: '1', state: 'waiting' }), sess({ id: '2' }), sess({ id: '3', state: 'unknown' })],
    }), NOW);
    expect(row(html)).toEqual(['class="row st-alert"', 'class="row st-info"', 'class="row st-muted"']);
    expect(html).toContain('<span class="tag tone-info">[PRACUJE]</span>');
  });
  it('runners and queue tones', () => {
    const runners = ['busy', 'idle', 'offline'].map((s, i) => ({ id: i, name: s, os: 'x', labels: [], state: s, job: null }));
    expect(row(renderRunners(state({ runners }), NOW))).toEqual(['class="row st-info"', 'class="row st-ok"', 'class="row st-alert"']);
    const base = { id: 1, repo: 'r', workflow: 'w', runNumber: 1, branch: 'b', url: 'u', createdAt: NOW, startedAt: null, labels: [], runnerName: null };
    const queue = [{ ...base, state: 'in_progress' }, { ...base, id: 2, state: 'queued' }];
    expect(row(renderQueue(state({ queue }), NOW))).toEqual(['class="row st-info"', 'class="row st-warn"']);
  });
  it('PR merge tag, checks and review tones', () => {
    const pr = {
      id: 'p', repo: 'r', number: 1, title: 't', url: 'u', draft: false,
      checks: { state: 'pending', passed: 0, failed: 0, total: 1 }, review: 'approved', merge: 'ready',
    };
    const html = renderPrs(state({ prs: [pr] }));
    expect(row(html)).toEqual(['class="pr st-ok"']);
    expect(html).toContain('<span class="tag tone-ok">[GOTOWY]</span>');
    expect(html).toContain('tone-warn');
  });
  it('tiles color only non-zero counts', () => {
    const html = renderTiles(state({ sessions: [sess()] }));
    expect(html).toContain('<span class="tone-info">1 PRACUJE</span>');
    expect(html).not.toContain('tone-alert');
  });
});

describe('animation hooks', () => {
  it('rows carry a stable key and a status', () => {
    const html = renderSessions(state({ sessions: [sess({ id: 'abc', state: 'waiting' })] }), NOW);
    expect(html).toContain('data-key="s:abc"');
    expect(html).toContain('data-status="waiting"');
    expect(renderWaiting(state({ sessions: [sess({ id: 'abc', state: 'waiting' })] }), NOW)).toContain('data-key="w:abc"');
  });
  it('only working and running icons spin', () => {
    expect(renderSessions(state({ sessions: [sess()] }), NOW)).toContain('ico tone-info spin');
    expect(renderSessions(state({ sessions: [sess({ state: 'unknown' })] }), NOW)).not.toContain('spin');
  });
});
describe('needs-human PRs', () => {
  const pr = (o) => ({
    id: 'p1', repo: 'o/r', number: 7, title: 'Fix <x>', url: 'https://github.com/o/r/pull/7', draft: false,
    checks: { state: 'pass', passed: 1, failed: 0, total: 1 }, review: 'none', merge: 'ready',
    labels: [], needsHuman: false, ...o,
  });
  const human = pr({ needsHuman: true, labels: ['needs-human', '<lbl>'] });

  it('PR row: red tag, red tone, escaped labels', () => {
    const html = renderPrs(state({ prs: [human] }));
    expect(html).toContain('class="pr st-alert"');
    expect(html).toContain('<span class="tag tone-alert">[NEEDS HUMAN]</span>');
    expect(html).toContain('[GOTOWY]');
    expect(html).toContain('<span class="label tone-alert">needs-human</span>');
    expect(html).toContain('<span class="label">&lt;lbl&gt;</span>');
  });
  it('PR without the flag has no needs-human tag', () => {
    expect(renderPrs(state({ prs: [pr()] }))).not.toContain('NEEDS HUMAN');
  });
  it('waiting block lists the PR and counts it with sessions', () => {
    const html = renderWaiting(state({ prs: [human], sessions: [sess({ state: 'waiting' })] }), NOW);
    expect(html).toContain('>02<');
    expect(html).toContain('data-key="w:pr:p1"');
    expect(html).toContain('href="https://github.com/o/r/pull/7"');
    expect(html).toContain('o/r #7 / Fix &lt;x&gt;');
    expect(html).toContain('MAX_WAIT 5 MIN');
  });
  it('waiting block with only a PR is red and has no MAX_WAIT', () => {
    const html = renderWaiting(state({ prs: [human] }), NOW);
    expect(html).toContain('is-alert');
    expect(html).toContain('>01<');
    expect(html).not.toContain('MAX_WAIT');
  });
  it('tile counts them', () => {
    expect(renderTiles(state({ prs: [human, pr({ id: 'p2' })] }))).toContain('<span class="tone-alert">1 NEEDS HUMAN</span>');
  });
});
describe('session name', () => {
  const s = (o) => sess({ project: 'social-media-tool-1cc0d7', task: 'zrób narzędzie', state: 'waiting', ...o });
  const views = (x) => [renderSessions(state({ sessions: [x] }), NOW), renderWaiting(state({ sessions: [x] }), NOW)];
  it('shows the session title only, never the folder or branch', () => {
    for (const html of views(s({ title: 'Narzędzie <social>' }))) {
      expect(html).toContain('<div class="t">Narzędzie &lt;social&gt;</div>');
      expect(html).not.toContain('1cc0d7');
      expect(html).not.toContain('zrób narzędzie');
    }
  });
  it('falls back to the first prompt, then to a neutral name', () => {
    for (const html of views(s({}))) expect(html).toContain('<div class="t">zrób narzędzie</div>');
    for (const html of views(s({ task: '' }))) {
      expect(html).toContain('<div class="t">Sesja bez nazwy</div>');
      expect(html).not.toContain('1cc0d7');
    }
  });
});

describe('waitingCount', () => {
  it('counts waiting sessions and needs-human PRs', () => {
    const prs = [{ id: 'a', needsHuman: true }, { id: 'b', needsHuman: false }];
    expect(waitingCount(state({ sessions: [sess({ state: 'waiting' }), sess({ id: 'b' })], prs }))).toBe(2);
  });
});
describe('favicon', () => {
  it('turns red only while something waits for the user', () => {
    expect(faviconFor(state({ sessions: [sess({})] }))).toBe('/favicon.svg');
    expect(faviconFor(state({ sessions: [sess({ state: 'waiting' })] }))).toBe('/favicon-alert.svg');
    expect(faviconFor(state({ prs: [{ id: 'a', needsHuman: true }] }))).toBe('/favicon-alert.svg');
  });
  it('both files exist and the page links one', () => {
    for (const f of ['favicon.svg', 'favicon-alert.svg']) expect(readFileSync(`public/${f}`, 'utf8')).toContain('<svg');
    expect(readFileSync('public/index.html', 'utf8')).toContain('<link id="favicon" rel="icon" type="image/svg+xml" href="/favicon.svg">');
  });
});
describe('session waiting for a PR', () => {
  it('has its own warn tag, not the working or waiting one', () => {
    const s = state({ sessions: [sess({ waitsFor: 'pr', detail: 'czeka na PR #5' })] });
    const html = renderSessions(s, NOW);
    expect(html).toContain('class="row st-warn"');
    expect(html).toContain('<span class="tag tone-warn">[CZEKA NA PR]</span>');
    expect(html).not.toContain('[PRACUJE]');
    expect(renderWaiting(s, NOW)).toContain('Nic nie czeka');
  });
});