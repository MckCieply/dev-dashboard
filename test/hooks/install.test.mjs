import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EVENTS, hookCommand, addHooks, removeHooks } from '../../scripts/install-hooks.mjs';

const P = '/x/dev-dashboard/hooks/report.mjs';
const CLI = path.resolve('scripts/install-hooks.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dd-install-'));

describe('install-hooks', () => {
  it('addHooks creates 8 events with correct shapes', () => {
    const s = addHooks({}, P);
    expect(Object.keys(s.hooks).sort()).toEqual([...EVENTS].sort());
    expect(EVENTS).toHaveLength(8);
    const h = [{ type: 'command', command: `node "${P}"`, timeout: 5 }];
    expect(s.hooks.PreToolUse).toEqual([{ matcher: '*', hooks: h }]);
    expect(s.hooks.Stop).toEqual([{ hooks: h }]);
  });

  it('is idempotent', () => {
    const once = addHooks({}, P);
    expect(addHooks(once, P)).toEqual(once);
  });

  it('keeps foreign hooks and removeHooks restores the original', () => {
    const foreign = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    const added = addHooks(foreign, P);
    expect(added.hooks.Stop).toHaveLength(2);
    expect(added.hooks.Stop[0]).toEqual(foreign.hooks.Stop[0]);
    expect(removeHooks(added, P)).toEqual(foreign);
    expect(foreign.hooks.Stop).toHaveLength(1);
  });

  it('uses forward slashes for Windows paths', () => {
    expect(hookCommand('C:\\x\\dev-dashboard\\hooks\\report.mjs')).toBe('node "C:/x/dev-dashboard/hooks/report.mjs"');
    const s = addHooks({}, 'C:\\x\\dev-dashboard\\hooks\\report.mjs');
    expect(s.hooks.Stop[0].hooks[0].command).not.toContain('\\');
    expect(removeHooks(s, 'C:\\x\\dev-dashboard\\hooks\\report.mjs')).toEqual({});
  });

  it('CLI writes the file and a backup', () => {
    const f = path.join(tmp(), 'settings.json');
    fs.writeFileSync(f, JSON.stringify({ model: 'x' }));
    const r = spawnSync(process.execPath, [CLI, '--settings', f, '--yes'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(out.model).toBe('x');
    expect(Object.keys(out.hooks)).toHaveLength(8);
    expect(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith('settings.json.bak-'))).toBe(true);
    const u = spawnSync(process.execPath, [CLI, '--settings', f, '--yes', '--uninstall'], { encoding: 'utf8' });
    expect(u.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ model: 'x' });
  });

  it('CLI exits 1 on invalid JSON and leaves the file unchanged', () => {
    const f = path.join(tmp(), 'settings.json');
    fs.writeFileSync(f, '{ broken');
    const r = spawnSync(process.execPath, [CLI, '--settings', f, '--yes'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(fs.readFileSync(f, 'utf8')).toBe('{ broken');
  });
});
