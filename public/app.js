import {
  renderHeader, renderWaiting, renderTiles, renderSessions, renderRunners, renderQueue, renderPrs, renderFooter,
} from './render.js';

let state = null;
let connected = false;
const last = new Map();

function put(id, html) {
  if (last.get(id) === html) return;
  last.set(id, html);
  document.getElementById(id).innerHTML = html;
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
  const waiting = state.sessions.filter((s) => s.state === 'waiting').length;
  document.title = waiting > 0 ? `(${waiting}) Dev dashboard` : 'Dev dashboard';
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
