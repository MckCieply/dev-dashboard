import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../types.js';
import { SYSTEM_TAG, type Sessions } from './machine.js';

const STATES = new Set(['waiting', 'working', 'unknown']);

function validSession(e: unknown): e is Session {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const o = e as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.state === 'string' && STATES.has(o.state)
    && typeof o.since === 'number' && Number.isFinite(o.since)
    && typeof o.lastEventAt === 'number' && Number.isFinite(o.lastEventAt);
}

export function loadSessions(file: string): Sessions {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Sessions = {};
      for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
        if (!validSession(e)) continue;
        // Older versions saved harness tags as the task name; the next prompt sets a real one.
        out[k] = typeof e.task === 'string' && SYSTEM_TAG.test(e.task) ? { ...e, task: '' } : e;
      }
      return out;
    }
    throw new Error('not an object');
  } catch (e) {
    process.stderr.write(`dev-dashboard: ignoring corrupt ${file}: ${(e as Error).message}\n`);
    return {};
  }
}

export function createSessionSaver(file: string, delayMs = 1000): { save(s: Sessions): void; flush(): void } {
  let pending: Sessions | null = null;
  let timer: NodeJS.Timeout | null = null;

  const write = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending) return;
    const data = pending;
    pending = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (e) {
      process.stderr.write(`dev-dashboard: cannot save sessions: ${(e as Error).message}\n`);
    }
  };

  return {
    save(s) {
      pending = s;
      if (timer) clearTimeout(timer);
      timer = setTimeout(write, delayMs);
      timer.unref?.();
    },
    flush: write,
  };
}
