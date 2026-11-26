import fs from 'node:fs';
import path from 'node:path';
import type { Sessions } from './machine.js';

export function loadSessions(file: string): Sessions {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Sessions;
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
