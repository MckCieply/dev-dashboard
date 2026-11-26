import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSessions } from '../../src/sessions/persist.js';

describe('loadSessions task cleanup', () => {
  it('drops saved task names that are raw system tags', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-')), 's.json');
    const s = (id: string, task: string) => ({ id, project: 'p', cwd: '', task, where: 'lokalna', state: 'working', detail: 'd', since: 1, lastEventAt: 1 });
    fs.writeFileSync(file, JSON.stringify({ a: s('a', '<system-reminder>'), b: s('b', '<agent-message from="x">'), c: s('c', 'Fix') }));
    const out = loadSessions(file);
    expect([out.a.task, out.b.task, out.c.task]).toEqual(['', '', 'Fix']);
  });
});