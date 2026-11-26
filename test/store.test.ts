import { describe, it, expect, vi } from 'vitest';
import { Store } from '../src/store.js';
import type { Session } from '../src/types.js';

const mk = (o: Partial<Session>): Session => ({
  id: 'x', project: 'p', cwd: '/p', task: '', where: 'lokalna', state: 'working', detail: '', since: 0, lastEventAt: 0, ...o,
});

describe('Store', () => {
  it('applyHook emits once with next/prev', () => {
    const s = new Store({ toasts: true, now: () => 1000 });
    const fn = vi.fn();
    s.onChange(fn);
    s.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 'a', cwd: '/x/proj', prompt: 'hi' });
    expect(fn).toHaveBeenCalledTimes(1);
    const [next, prev] = fn.mock.calls[0];
    expect(prev.sessions).toHaveLength(0);
    expect(next.sessions[0].id).toBe('a');
    expect(next.collectors.sessions.lastSuccessAt).toBe(1000);
  });

  it('unsubscribe works', () => {
    const s = new Store({ toasts: true });
    const fn = vi.fn();
    const off = s.onChange(fn);
    off();
    s.setRepos(['a/b']);
    expect(fn).not.toHaveBeenCalled();
  });

  it('sorts waiting (oldest first), working, unknown; ties by project', () => {
    const s = new Store({
      toasts: true,
      sessions: {
        w1: mk({ id: 'w1', state: 'working', project: 'b' }),
        w2: mk({ id: 'w2', state: 'working', project: 'a' }),
        u: mk({ id: 'u', state: 'unknown' }),
        a2: mk({ id: 'a2', state: 'waiting', since: 200 }),
        a1: mk({ id: 'a1', state: 'waiting', since: 100 }),
      },
    });
    expect(s.get().sessions.map((x) => x.id)).toEqual(['a1', 'a2', 'w2', 'w1', 'u']);
  });

  it('setCollector merges', () => {
    const s = new Store({ toasts: true });
    s.setCollector('runners', { ok: true, lastSuccessAt: 5 });
    s.setCollector('runners', { error: 'x' });
    expect(s.get().collectors.runners).toEqual({ ok: true, lastSuccessAt: 5, error: 'x' });
    expect(s.get().collectors.prs).toEqual({ ok: false, lastSuccessAt: null, error: null });
    expect(s.get().collectors.sessions.ok).toBe(true);
  });

  it('sweepSessions emits nothing when nothing stale', () => {
    const s = new Store({ toasts: true, now: () => 10, sessions: { a: mk({ id: 'a', lastEventAt: 5 }) } });
    const fn = vi.fn();
    s.onChange(fn);
    s.sweepSessions();
    expect(fn).not.toHaveBeenCalled();
  });

  it('sweepSessions emits when stale', () => {
    let t = 0;
    const s = new Store({ toasts: true, now: () => t, sessions: { a: mk({ id: 'a', lastEventAt: 0 }) } });
    const fn = vi.fn();
    s.onChange(fn);
    t = 31 * 60_000;
    s.sweepSessions();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].sessions[0].state).toBe('unknown');
  });

  it('get() returns fresh objects with injected clock; setters emit once', () => {
    let t = 1;
    const s = new Store({ toasts: false, now: () => t });
    const a = s.get();
    t = 2;
    const b = s.get();
    expect(a).not.toBe(b);
    expect(b.now).toBe(2);
    expect(b.toasts).toBe(false);
    const fn = vi.fn();
    s.onChange(fn);
    s.setRunners([]); s.setQueue([]); s.setPrs([]); s.setRate(null);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

describe('session titles', () => {
  const ev = { session_id: 's1', cwd: '/w/p-1a2b', hook_event_name: 'UserPromptSubmit', prompt: 'x' };
  it('sets the title with the hook event', () => {
    const store = new Store({ toasts: false, titleOf: () => 'Ładna nazwa' });
    store.applyHook(ev);
    expect(store.get().sessions[0].title).toBe('Ładna nazwa');
  });
  it('titles restored sessions and picks up renames with one change', () => {
    let name: string | null = null;
    const first = new Store({ toasts: false });
    first.applyHook(ev);
    const store = new Store({ toasts: false, sessions: first.getSessions(), titleOf: () => name });
    let changes = 0;
    store.onChange(() => { changes++; });
    store.refreshTitles();
    expect(changes).toBe(0);
    name = 'Nowa';
    store.refreshTitles();
    store.refreshTitles();
    expect(changes).toBe(1);
    expect(store.get().sessions[0].title).toBe('Nowa');
    name = null;
    store.refreshTitles();
    expect(store.get().sessions[0].title).toBe('Nowa');
  });
});