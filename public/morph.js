// Patches the live DOM to match new HTML and keeps existing nodes, so CSS animations do not restart.
// Children are matched by data-key, otherwise by position.
const ANIM = ['flash', 'enter'];

const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') : null);
const sameKind = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName;

function animate(el, name) {
  el.classList.remove(...ANIM);
  void el.getBoundingClientRect(); // restart when the same animation is still running
  el.classList.add(name);
  el.addEventListener('animationend', function done(e) {
    if (e.target !== el) return;
    el.classList.remove(name);
    el.removeEventListener('animationend', done);
  });
}

function syncAttributes(from, to) {
  const running = ANIM.filter((c) => from.classList.contains(c));
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) {
    const next = name === 'class' && running.length ? `${value} ${running.join(' ')}` : value;
    if (from.getAttribute(name) !== next) from.setAttribute(name, next);
  }
}

function patch(from, to, animateNew) {
  if (from.nodeType !== 1) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  const before = from.getAttribute('data-status');
  syncAttributes(from, to);
  patchChildren(from, to, animateNew);
  const after = from.getAttribute('data-status');
  if (before !== null && before !== after) animate(from, 'flash');
}

export function patchChildren(parent, next, animateNew) {
  const keyed = new Map();
  for (const n of parent.childNodes) if (keyOf(n) !== null) keyed.set(keyOf(n), n);
  let cursor = parent.firstChild;
  for (const want of [...next.childNodes]) {
    const key = keyOf(want);
    let have = null;
    if (key !== null) have = keyed.get(key) ?? null;
    else if (cursor && keyOf(cursor) === null && sameKind(cursor, want)) have = cursor;
    if (have && sameKind(have, want)) {
      // Moving a node restarts its animations, so move only when the order changed.
      if (have === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(have, cursor);
      keyed.delete(key);
      patch(have, want, animateNew);
    } else {
      parent.insertBefore(want, cursor);
      if (animateNew && key !== null) animate(want, 'enter');
    }
  }
  while (cursor) {
    const dead = cursor;
    cursor = cursor.nextSibling;
    parent.removeChild(dead);
  }
}
