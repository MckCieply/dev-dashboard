// Pure render functions: state in, HTML string out. No DOM access.
import { ICON } from './icons.js';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Folder and branch names are not session names, so they never show.
const sessionName = (s) => esc(s.title || s.task || 'Sesja bez nazwy');

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ENT[c]);
}

const pad2 = (n) => String(n).padStart(2, '0');

export function fmtDuration(ms) {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'teraz';
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.floor(min / (24 * 60))} d`;
}

export function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtClockSec(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Color per status key (DESIGN_DIRECTION status map).
const TONE = {
  waiting: 'alert', working: 'info', unknown: 'muted',
  busy: 'info', idle: 'ok', offline: 'alert',
  running: 'info', queued: 'warn',
  human: 'alert',
  pass: 'ok', fail: 'alert', pending: 'warn', none: 'muted',
};
const MERGE_TONE = { ready: 'ok', blocked: 'warn', conflict: 'alert', draft: 'muted', unknown: 'muted' };
const SPINNING = new Set(['working', 'running']);

function icon(key, size = 16, sw = 2.4) {
  const cls = `ico tone-${TONE[key] ?? 'muted'}${SPINNING.has(key) ? ' spin' : ''}`;
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="${ICON[key] ?? ICON.pending}"></path></svg>`;
}

// data-key keeps a row's DOM node (and its animation) across repaints; data-status drives the change flash.
const rowAttrs = (cls, tone, key, status) => `class="${cls} st-${tone}" data-key="${esc(key)}" data-status="${esc(status)}"`;
const tag = (tone, label) => `<span class="tag tone-${tone}">${label}</span>`;
const count = (tone, n, label) => (n ? `<span class="tone-${tone}">${n} ${label}</span>` : `0 ${label}`);

const SESSION_LABEL = { waiting: '[CZEKA]', working: '[PRACUJE]', unknown: '[NIEZNANY]' };
const RUNNER_LABEL = { busy: '[ZAJĘTY]', idle: '[WOLNY]', offline: '[OFFLINE]' };
const RUN_LABEL = { in_progress: '[W TRAKCIE]', queued: '[W KOLEJCE]' };
const RUN_ICON = { in_progress: 'running', queued: 'queued' };
const MERGE_LABEL = { ready: '[GOTOWY]', blocked: '[ZABLOKOWANY]', conflict: '[KONFLIKT]', draft: '[DRAFT]', unknown: '[?]' };
const WHERE_LABEL = { lokalna: '[LOKALNA]', chmura: '[CHMURA]' };

export function collectorError(status, label) {
  if (!status || !status.error) return '';
  const tail = status.lastSuccessAt ? `dane z ${fmtClock(status.lastSuccessAt)}` : 'brak danych';
  return `<p class="err">${esc(label)}: ${esc(status.error)}, ${tail}</p>`;
}

function panel(id, title, sub, inner, stale = false) {
  return `<section class="cell${stale ? ' is-stale' : ''}" aria-labelledby="${id}"><h2 class="head" id="${id}">// ${esc(title)} <small>${esc(sub)}</small></h2>${inner}</section>`;
}

const empty = (text) => `<p class="empty">${esc(text)}</p>`;

export function renderHeader(state, now, connected) {
  const times = Object.values(state.collectors).map((c) => c.lastSuccessAt).filter((t) => typeof t === 'number');
  const sync = times.length ? fmtClockSec(Math.max(...times)) : '—';
  const rate = state.rate ? `${state.rate.remaining}/${state.rate.limit}` : '—';
  const live = connected
    ? '<span class="live"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" fill="currentColor"></rect></svg>LIVE</span>'
    : '<span class="tone-alert">[ROZŁĄCZONO]</span>';
  return `<header class="bar"><h1>Dev dashboard</h1><div class="meta m">${live}<span>SYNC ${sync}</span><span>GH_API ${esc(rate)}</span><span>TOAST ${state.toasts ? 'ON' : 'OFF'}</span></div>${collectorError(state.collectors.repos, 'Repozytoria')}</header>`;
}

const waitingOf = (state) => state.sessions.filter((s) => s.state === 'waiting').sort((a, b) => a.since - b.since);

const humanOf = (state) => state.prs.filter((p) => p.needsHuman);

export const waitingCount = (state) => waitingOf(state).length + humanOf(state).length;

export const faviconFor = (state) => (waitingCount(state) > 0 ? '/favicon-alert.svg' : '/favicon.svg');

export function renderWaiting(state, now) {
  const list = waitingOf(state);
  const total = waitingCount(state);
  if (total === 0) {
    return `<section class="waiting" aria-labelledby="wait-h"><div class="wait-side"><h2 class="m" id="wait-h">Czeka na Ciebie</h2><div class="wait-count" aria-live="polite">00</div></div><div class="wait-rows"><p class="empty">Nic nie czeka</p></div></section>`;
  }
  const prRows = humanOf(state).map((p) => `<div class="row row-wait" data-key="w:pr:${esc(p.id)}">${icon('human')}<div><div class="t">${prTitle(p)}</div><div class="s">&gt; PR wymaga człowieka</div></div>${tag('alert', '[NEEDS HUMAN]')}<span class="since m"></span></div>`).join('');
  const rows = prRows + list.map((s) => `<div class="row row-wait" data-key="w:${esc(s.id)}">${icon('waiting')}<div><div class="t">${sessionName(s)}</div><div class="s">&gt; ${esc(s.detail)}</div></div><span class="tag muted">${WHERE_LABEL[s.where] ?? esc(s.where)}</span><span class="since m">${fmtDuration(now - s.since)}</span></div>`).join('');
  return `<section class="waiting is-alert" aria-labelledby="wait-h"><div class="wait-side"><h2 class="m" id="wait-h">[!] Czeka na Ciebie</h2><div class="wait-count" aria-live="polite">${pad2(total)}</div>${list.length ? `<div class="m wait-max">MAX_WAIT ${esc(fmtDuration(now - list[0].since).toUpperCase())}</div>` : ''}</div><div class="wait-rows">${rows}</div></section>`;
}

export function renderTiles(state) {
  const cnt = (arr, f) => arr.filter(f).length;
  const { sessions, runners, queue, prs } = state;
  const online = cnt(runners, (r) => r.state !== 'offline');
  const offline = runners.length - online;
  const queued = queue.filter((q) => q.state === 'queued');
  const running = cnt(queue, (q) => q.state === 'in_progress');
  const maxWait = queued.length ? Math.max(...queued.map((q) => state.now - q.createdAt)) : 0;
  const failing = cnt(prs, (p) => p.checks.state === 'fail');
  const human = cnt(prs, (p) => p.needsHuman);
  const ses = (st) => cnt(sessions, (s) => s.state === st);
  const run = (st) => cnt(runners, (r) => r.state === st);
  const tile = (name, big, unit, sub) => `<div class="cell tile"><span class="tag muted">${name}</span><span class="big">${big}${unit ? ` <span class="unit">${unit}</span>` : ''}</span><span class="s">${sub}</span></div>`;
  return [
    tile('Sesje', pad2(sessions.length), '',
      `${count('info', ses('working'), 'PRACUJE')} · ${count('alert', ses('waiting'), 'CZEKA')} · ${ses('unknown')} NIEZNANY`),
    tile('Runnery', `${online}/${runners.length}`, 'ONLINE',
      `${count('info', run('busy'), 'ZAJĘTY')} · ${count('ok', run('idle'), 'WOLNY')} · ${count('alert', offline, 'OFFLINE')}`),
    tile('Kolejka CI', pad2(queued.length), 'QUEUED',
      `${count('info', running, 'RUNNING')}${queued.length ? ` · <span class="tone-warn">MAX ${esc(fmtDuration(maxWait).toUpperCase())}</span>` : ''}`),
    tile('Pull requesty', pad2(prs.length), 'OPEN',
      `${human ? `${count('alert', human, 'NEEDS HUMAN')} · ` : ''}${count('ok', cnt(prs, (p) => p.merge === 'ready'), 'READY')} · ${count('alert', failing, 'FAIL')}`),
  ].join('');
}

function sessionRow(s, now) {
  // Waiting for CI is waiting on the system, so it looks like a queued run.
  const pr = s.state === 'working' && s.waitsFor === 'pr';
  const key = pr ? 'queued' : s.state;
  const tone = TONE[key] ?? 'muted';
  const label = pr ? '[CZEKA NA PR]' : SESSION_LABEL[s.state] ?? esc(s.state);
  return `<div ${rowAttrs('row', tone, `s:${s.id}`, key)}>${icon(key)}<div><div class="t">${sessionName(s)}</div><div class="s">${esc(s.where)} · ${esc(s.detail)} · ${fmtDuration(now - s.since)}</div></div>${tag(tone, label)}</div>`;
}

export function renderSessions(state, now) {
  const rows = state.sessions.map((s) => sessionRow(s, now)).join('');
  return panel('ses-h', 'Sesje', 'LOCAL + CLOUD', collectorError(state.collectors.sessions, 'Sesje') + (rows || empty('Brak sesji')), !state.collectors.sessions.ok && rows !== '');
}

function runnerDetail(r, now) {
  if (r.state === 'busy' && r.job) return `${esc(r.job.repo)} · ${esc(r.job.workflow)} #${esc(r.job.runNumber)} · ${fmtDuration(now - r.job.startedAt)}`;
  if (r.state === 'idle') return 'wolny';
  if (r.state === 'offline') return 'offline';
  return 'zajęty';
}

export function renderRunners(state, now) {
  const rows = state.runners.map((r) => `<div ${rowAttrs('row', TONE[r.state] ?? 'muted', `r:${r.id}`, r.state)}>${icon(r.state)}<div><div class="t">${esc(r.name)}</div><div class="s">${esc(r.os)} · ${runnerDetail(r, now)}</div></div>${tag(TONE[r.state] ?? 'muted', RUNNER_LABEL[r.state] ?? esc(r.state))}</div>`).join('');
  return panel('run-h', 'Runnery', 'ALL INCL. OFFLINE', collectorError(state.collectors.runners, 'Runnery') + (rows || empty('Brak runnerów')), !state.collectors.runners.ok && rows !== '');
}

function queueDetail(q, now) {
  if (q.state === 'in_progress') return `${fmtDuration(now - (q.startedAt ?? q.createdAt))}${q.runnerName ? ` · ${esc(q.runnerName)}` : ''}`;
  return `czeka ${fmtDuration(now - q.createdAt)} · potrzebuje: ${esc(q.labels.join(', '))}`;
}

export function renderQueue(state, now) {
  const rows = state.queue.map((q) => {
    const key = RUN_ICON[q.state] ?? 'queued';
    return `<div ${rowAttrs('row', TONE[key], `q:${q.id}`, q.state)}>${icon(key)}<div><div class="t">${esc(q.repo)} / ${esc(q.workflow)} #${esc(q.runNumber)}</div><div class="s">${esc(q.branch)} · ${queueDetail(q, now)}</div></div>${tag(TONE[key], RUN_LABEL[q.state] ?? esc(q.state))}</div>`;
  }).join('');
  return panel('q-h', 'Kolejka runów', 'ACTIVE REPOS', collectorError(state.collectors.queue, 'Kolejka') + (rows || empty('Kolejka pusta')), !state.collectors.queue.ok && rows !== '');
}

function checksView(c) {
  switch (c.state) {
    case 'pass': return ['pass', `${c.passed} z ${c.total} OK`];
    case 'fail': return ['fail', `${c.failed} z ${c.total} nie przeszło`];
    case 'pending': return ['pending', `w toku, ${c.passed} z ${c.total}`];
    default: return ['none', 'brak checków'];
  }
}

const REVIEW_VIEW = {
  approved: ['pass', 'zatwierdzony'],
  changes_requested: ['fail', 'prośba o zmiany'],
  review_required: ['pending', 'czeka na review'],
  draft: ['none', 'draft'],
  none: ['none', 'bez review'],
};

// Only http(s) links; anything else renders as plain text.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u)) ? String(u) : null);

function prTitle(p) {
  const title = `${esc(p.repo)} #${esc(p.number)} / ${esc(p.title)}`;
  const href = safeUrl(p.url);
  return href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${title}</a>` : title;
}

// Only the label that still asks for a person is red.
function prLabels(p) {
  const spans = (p.labels ?? []).map((l) => `<span class="label${p.needsHuman && l.toLowerCase() === 'needs-human' ? ' tone-alert' : ''}">${esc(l)}</span>`).join('');
  return spans ? `<div class="pr-labels">${spans}</div>` : '';
}

export function renderPrs(state) {
  const rows = state.prs.map((p) => {
    const [ck, ct] = checksView(p.checks);
    const [rk, rt] = REVIEW_VIEW[p.review] ?? REVIEW_VIEW.none;
    const mergeTone = MERGE_TONE[p.merge] ?? 'muted';
    const tags = `${p.needsHuman ? tag('alert', '[NEEDS HUMAN]') : ''}${tag(mergeTone, MERGE_LABEL[p.merge] ?? '[?]')}`;
    const status = `${p.merge} ${p.checks.state} ${p.review} ${p.needsHuman ? 'human' : ''}`;
    return `<div ${rowAttrs('pr', p.needsHuman ? 'alert' : mergeTone, `p:${p.id}`, status)}><div class="pr-top"><div class="t">${prTitle(p)}</div><div class="pr-tags">${tags}</div></div>${prLabels(p)}<div class="s pr-meta"><span>${icon(ck, 14, 2.6)}${ct}</span><span>${icon(rk, 14, 2.6)}${rt}</span></div></div>`;
  }).join('');
  return panel('pr-h', 'Pull requesty', 'OPEN', collectorError(state.collectors.prs, 'PR') + (rows || empty('Brak otwartych PR')), !state.collectors.prs.ok && rows !== '');
}

export function renderFooter(state) {
  if (!state.rate || !state.rate.slowed) return '';
  return `<p class="foot m">Limit GitHub niski: odświeżanie co 2 min do ${fmtClock(state.rate.resetAt)}</p>`;
}
