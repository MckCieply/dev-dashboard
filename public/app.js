import {
  renderHeader, renderWaiting, renderTiles, renderSessions, renderRunners, renderQueue, renderPrs, renderFooter, waitingCount, faviconFor,
} from './render.js';
import { patchChildren } from './morph.js';

let state = null;
let connected = false;
const last = new Map();

function put(id, html) {
  if (last.get(id) === html) return;
  const first = !last.has(id);
  last.set(id, html);
  const next = document.createElement('template');
  next.innerHTML = html;
  // Rows present on the first paint do not slide in.
  patchChildren(document.getElementById(id), next.content, !first);
}

function paint() {
  if (!state) return;
  const now = Date.now();
  put('header', renderHeader(state, now, connected));
  put('waiting', renderWaiting(state, now));
  put('tiles', renderTiles(state));
  put('sessions', renderSessions(state, now));
  put('runners', renderRunners(state, now));
  put('queue', renderQueue(state, now));
  put('prs', renderPrs(state));
  put('footer', renderFooter(state));
  const waiting = waitingCount(state);
  document.title = waiting > 0 ? `(${waiting}) Dev dashboard` : 'Dev dashboard';
  const link = document.getElementById('favicon');
  const href = faviconFor(state);
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

const es = new EventSource('/api/events');
es.addEventListener('state', (e) => {
  state = JSON.parse(e.data);
  connected = true;
  paint();
});
es.addEventListener('error', () => {
  connected = false;
  paint();
});
setInterval(paint, 1000);
