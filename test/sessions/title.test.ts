import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTitleReader } from '../../src/sessions/title.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const title = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: 'abc-1' });
function setup(lines: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-title-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'C--other'));
  fs.mkdirSync(path.join(root, 'C--proj'));
  const file = path.join(root, 'C--proj', 'abc-1.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { root, file, read: createTitleReader(root) };
}

describe('createTitleReader', () => {
  it('returns the latest custom title from the transcript', () => {
    const { read } = setup([title('Stary'), '{"type":"user"}', title('Narzędzie do kont')]);
    expect(read('abc-1')).toBe('Narzędzie do kont');
  });
  it('ignores title text quoted inside a message', () => {
    const { read } = setup([title('Prawdziwy'), JSON.stringify({ type: 'user', message: title('Cytat') })]);
    expect(read('abc-1')).toBe('Prawdziwy');
  });
  it('sees a rename', () => {
    const { read, file } = setup([title('A')]);
    expect(read('abc-1')).toBe('A');
    fs.appendFileSync(file, title('Nowa nazwa') + '\n');
    expect(read('abc-1')).toBe('Nowa nazwa');
  });
  it('reads the tail of a big file and keeps the last title when the tail has none', () => {
    const filler = JSON.stringify({ type: 'user', message: 'x'.repeat(600_000) });
    const { read, file } = setup([filler, title('W ogonie')]);
    expect(read('abc-1')).toBe('W ogonie');
    fs.appendFileSync(file, filler + '\n');
    expect(read('abc-1')).toBe('W ogonie');
  });
  it('returns null without a title, a file or a directory', () => {
    expect(setup(['{"type":"user"}']).read('abc-1')).toBeNull();
    expect(setup([title('A')]).read('missing')).toBeNull();
    expect(createTitleReader('/no/such/dir')('abc-1')).toBeNull();
  });
  it('rejects ids that could leave the directory', () => {
    const { root } = setup([title('A')]);
    expect(createTitleReader(path.join(root, 'C--other'))('../C--proj/abc-1')).toBeNull();
  });
});