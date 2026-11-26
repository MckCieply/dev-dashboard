// Pure render functions: state in, HTML string out. No DOM access.
import { ICON } from './icons.js';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function projectTask(s) {
  return s.task ? `${esc(s.project)} / ${esc(s.task)}` : esc(s.project);
}

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

// Icon color class per status key (DESIGN_DIRECTION status map).
const TONE = {
  waiting: 'tone-alert', working: 'tone-ink', unknown: 'tone-muted',
  busy: 'tone-ink', idle: 'tone-muted', offline: 'tone-alert',
  running: 'tone-ink', queued: 'tone-muted',
  pass: 'tone-ink', fail: 'tone-alert', pending: 'tone-muted',
};

function icon(key, size = 16, sw = 2.4) {
  return `<svg class="ico ${TONE[key]}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="${ICON[key]}"></path></svg>`;
}

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

export function renderWaiting(state, now) {
  const list = waitingOf(state);
  if (list.length === 0) {
    return `<section class="waiting" aria-labelledby="wait-h"><div class="wait-side"><h2 class="m" id="wait-h">Czeka na Ciebie</h2><div class="wait-count" aria-live="polite">00</div></div><div class="wait-rows"><p class="empty">Nic nie czeka</p></div></section>`;
  }
  const rows = list.map((s) => `<div class="row row-wait">${icon('waiting')}<div><div class="t">${projectTask(s)}</div><div class="s">&gt; ${esc(s.detail)}</div></div><span class="tag muted">${WHERE_LABEL[s.where] ?? esc(s.where)}</span><span class="since m">${fmtDuration(now - s.since)}</span></div>`).join('');
  return `<section class="waiting is-alert" aria-labelledby="wait-h"><div class="wait-side"><h2 class="m" id="wait-h">[!] Czeka na Ciebie</h2><div class="wait-count" aria-live="polite">${pad2(list.length)}</div><div class="m wait-max">MAX_WAIT ${esc(fmtDuration(now - list[0].since).toUpperCase())}</div></div><div class="wait-rows">${rows}</div></section>`;
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
  const tile = (name, big, unit, sub) => `<div class="cell tile"><span class="tag muted">${name}</span><span class="big">${big}${unit ? ` <span class="unit">${unit}</span>` : ''}</span><span class="s">${sub}</span></div>`;
  return [
    tile('Sesje', pad2(sessions.length), '',
      `${cnt(sessions, (s) => s.state === 'working')} PRACUJE · ${cnt(sessions, (s) => s.state === 'waiting')} CZEKA · ${cnt(sessions, (s) => s.state === 'unknown')} NIEZNANY`),
    tile('Runnery', `${online}/${runners.length}`, 'ONLINE',
      `${cnt(runners, (r) => r.state === 'busy')} ZAJĘTY · ${cnt(runners, (r) => r.state === 'idle')} WOLNY · ${offline ? `<span class="tone-alert">${offline} OFFLINE</span>` : '0 OFFLINE'}`),
    tile('Kolejka CI', pad2(queued.length), 'QUEUED',
      `${running} RUNNING${queued.length ? ` · MAX ${esc(fmtDuration(maxWait).toUpperCase())}` : ''}`),
    tile('Pull requesty', pad2(prs.length), 'OPEN',
      `${cnt(prs, (p) => p.merge === 'ready')} READY · ${failing ? `<span class="tone-alert">${failing} FAIL</span>` : '0 FAIL'}`),
  ].join('');
}

export function renderSessions(state, now) {
  const rows = state.sessions.map((s) => `<div class="row">${icon(s.state)}<div><div class="t">${projectTask(s)}</div><div class="s">${esc(s.where)} · ${esc(s.detail)} · ${fmtDuration(now - s.since)}</div></div><span class="tag">${SESSION_LABEL[s.state] ?? esc(s.state)}</span></div>`).join('');
  return panel('ses-h', 'Sesje', 'LOCAL + CLOUD', collectorError(state.collectors.sessions, 'Sesje') + (rows || empty('Brak sesji')), !state.collectors.sessions.ok && rows !== '');
}

function runnerDetail(r, now) {
  if (r.state === 'busy' && r.job) return `${esc(r.job.repo)} · ${esc(r.job.workflow)} #${esc(r.job.runNumber)} · ${fmtDuration(now - r.job.startedAt)}`;
  if (r.state === 'idle') return 'wolny';
  if (r.state === 'offline') return 'offline';
  return 'zajęty';
}

export function renderRunners(state, now) {
  const rows = state.runners.map((r) => `<div class="row">${icon(r.state)}<div><div class="t">${esc(r.name)}</div><div class="s">${esc(r.os)} · ${runnerDetail(r, now)}</div></div><span class="tag">${RUNNER_LABEL[r.state] ?? esc(r.state)}</span></div>`).join('');
  return panel('run-h', 'Runnery', 'ALL INCL. OFFLINE', collectorError(state.collectors.runners, 'Runnery') + (rows || empty('Brak runnerów')), !state.collectors.runners.ok && rows !== '');
}

function queueDetail(q, now) {
  if (q.state === 'in_progress') return `${fmtDuration(now - (q.startedAt ?? q.createdAt))}${q.runnerName ? ` · ${esc(q.runnerName)}` : ''}`;
  return `czeka ${fmtDuration(now - q.createdAt)} · potrzebuje: ${esc(q.labels.join(', '))}`;
}

export function renderQueue(state, now) {
  const rows = state.queue.map((q) => `<div class="row">${icon(RUN_ICON[q.state] ?? 'queued')}<div><div class="t">${esc(q.repo)} / ${esc(q.workflow)} #${esc(q.runNumber)}</div><div class="s">${esc(q.branch)} · ${queueDetail(q, now)}</div></div><span class="tag">${RUN_LABEL[q.state] ?? esc(q.state)}</span></div>`).join('');
  return panel('q-h', 'Kolejka runów', 'ACTIVE REPOS', collectorError(state.collectors.queue, 'Kolejka') + (rows || empty('Kolejka pusta')), !state.collectors.queue.ok && rows !== '');
}

function checksView(c) {
  switch (c.state) {
    case 'pass': return ['pass', `${c.passed} z ${c.total} OK`];
    case 'fail': return ['fail', `${c.failed} z ${c.total} nie przeszło`];
    case 'pending': return ['pending', `w toku, ${c.passed} z ${c.total}`];
    default: return ['pending', 'brak checków'];
  }
}

const REVIEW_VIEW = {
  approved: ['pass', 'zatwierdzony'],
  changes_requested: ['fail', 'prośba o zmiany'],
  review_required: ['pending', 'czeka na review'],
  draft: ['pending', 'draft'],
  none: ['pending', 'bez review'],
};

// Only http(s) links; anything else renders as plain text.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u)) ? String(u) : null);

export function renderPrs(state) {
  const rows = state.prs.map((p) => {
    const [ck, ct] = checksView(p.checks);
    const [rk, rt] = REVIEW_VIEW[p.review] ?? REVIEW_VIEW.none;
    const title = `${esc(p.repo)} #${esc(p.number)} / ${esc(p.title)}`;
    const href = safeUrl(p.url);
    const head = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${title}</a>` : title;
    return `<div class="pr"><div class="pr-top"><div class="t">${head}</div><span class="tag">${MERGE_LABEL[p.merge] ?? '[?]'}</span></div><div class="s pr-meta"><span>${icon(ck, 14, 2.6)}${ct}</span><span>${icon(rk, 14, 2.6)}${rt}</span></div></div>`;
  }).join('');
  return panel('pr-h', 'Pull requesty', 'OPEN', collectorError(state.collectors.prs, 'PR') + (rows || empty('Brak otwartych PR')), !state.collectors.prs.ok && rows !== '');
}

export function renderFooter(state) {
  if (!state.rate || !state.rate.slowed) return '';
  return `<p class="foot m">Limit GitHub niski: odświeżanie co 2 min do ${fmtClock(state.rate.resetAt)}</p>`;
}
