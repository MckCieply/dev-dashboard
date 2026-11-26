import fs from 'node:fs';
import path from 'node:path';

// Claude Code appends the session name to the transcript many times, so the tail is enough.
const TAIL_BYTES = 512 * 1024;
const PREFIX = '{"type":"custom-title"';

function readTail(file: string, size: number): string {
  const length = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    const read = fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function lastTitle(text: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith(PREFIX)) continue;
    try {
      const t = (JSON.parse(lines[i]) as { customTitle?: unknown }).customTitle;
      if (typeof t === 'string' && t.trim() !== '') return t.trim();
    } catch { /* a line still being written */ }
  }
  return null;
}

/** Reads `<projectsDir>/<project>/<session id>.jsonl` and returns the session's name. */
export function createTitleReader(projectsDir: string): (id: string) => string | null {
  const files = new Map<string, string>();
  const cache = new Map<string, { size: number; mtimeMs: number; title: string | null }>();

  function find(id: string): string | null {
    const known = files.get(id);
    if (known && fs.existsSync(known)) return known;
    for (const dir of fs.readdirSync(projectsDir)) {
      const file = path.join(projectsDir, dir, `${id}.jsonl`);
      if (fs.existsSync(file)) { files.set(id, file); return file; }
    }
    return null;
  }

  return (id) => {
    // The id comes from a hook payload: never let it name a path.
    if (!/^[\w-]+$/.test(id)) return null;
    const prev = cache.get(id);
    try {
      const file = find(id);
      if (!file) return null;
      const { size, mtimeMs } = fs.statSync(file);
      if (prev && prev.size === size && prev.mtimeMs === mtimeMs) return prev.title;
      const title = lastTitle(readTail(file, size)) ?? prev?.title ?? null;
      cache.set(id, { size, mtimeMs, title });
      return title;
    } catch {
      return prev?.title ?? null;
    }
  };
}
