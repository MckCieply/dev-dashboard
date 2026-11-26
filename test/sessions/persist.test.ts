import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSessions, createSessionSaver } from '../../src/sessions/persist.js';
import type { Sessions } from '../../src/sessions/machine.js';

const sess: Sessions = {
  a: { id: 'a', project: 'p', cwd: '/p', task: 't', where: 'lokalna', state: 'waiting', detail: 'd', since: 1, lastEventAt: 2 },
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dd-persist-'));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('persist', () => {
  it('round-trips (creates dirs)', () => {
    const file = path.join(tmp(), 'sub', 'sessions.json');
    const saver = createSessionSaver(file);
    saver.save(sess);
    saver.flush();
    expect(loadSessions(file)).toEqual(sess);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('missing file -> {}', () => {
    expect(loadSessions(path.join(tmp(), 'nope.json'))).toEqual({});
  });

  it('corrupt file -> {} with one warning', () => {
    const file = path.join(tmp(), 's.json');
    fs.writeFileSync(file, '{not json');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(loadSessions(file)).toEqual({});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('drops invalid entries and non-object roots on load', () => {
    const file = path.join(tmp(), 's.json');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fs.writeFileSync(file, JSON.stringify({
      a: null, good: sess.a, noId: { ...sess.a, id: 5 }, badState: { ...sess.a, state: 'zzz' },
      badSince: { ...sess.a, since: 'x' }, nanLast: { ...sess.a, lastEventAt: null }, str: 'x', arr: [1],
    }));
    expect(loadSessions(file)).toEqual({ good: sess.a });
    fs.writeFileSync(file, '[1,2]');
    expect(loadSessions(file)).toEqual({});
    fs.writeFileSync(file, 'null');
    expect(loadSessions(file)).toEqual({});
  });

  it('debounces saves', () => {
    vi.useFakeTimers();
    const file = path.join(tmp(), 's.json');
    const w = vi.spyOn(fs, 'writeFileSync');
    const saver = createSessionSaver(file);
    saver.save({});
    vi.advanceTimersByTime(200);
    saver.save({});
    vi.advanceTimersByTime(200);
    saver.save(sess);
    vi.advanceTimersByTime(900);
    expect(w).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(w).toHaveBeenCalledTimes(1);
    expect(loadSessions(file)).toEqual(sess);
  });

  it('flush writes immediately and cancels the timer', () => {
    vi.useFakeTimers();
    const file = path.join(tmp(), 's.json');
    const saver = createSessionSaver(file);
    saver.save(sess);
    saver.flush();
    expect(loadSessions(file)).toEqual(sess);
    const w = vi.spyOn(fs, 'writeFileSync');
    vi.advanceTimersByTime(5000);
    expect(w).not.toHaveBeenCalled();
  });
});
