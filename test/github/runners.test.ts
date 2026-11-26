import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapRunners, type RawRunner } from '../../src/github/runners.js';
import type { QueuedRun } from '../../src/types.js';

const raw = (JSON.parse(readFileSync(new URL('../fixtures/runners.json', import.meta.url), 'utf8')) as { runners: RawRunner[] }).runners;
const run = (over: Partial<QueuedRun> = {}): QueuedRun => ({
  id: 99, repo: 'acme/app', workflow: 'ci.yml', runNumber: 41, branch: 'main', state: 'in_progress',
  createdAt: 1, startedAt: 5000, labels: [], runnerName: 'win-runner-1', url: 'u', ...over,
});

describe('mapRunners', () => {
  it('maps state, os and sorts busy, idle, offline then name', () => {
    const out = mapRunners(raw, []);
    expect(out.map((r) => [r.name, r.state])).toEqual([
      ['win-runner-1', 'busy'], ['a-runner', 'idle'], ['linux-runner-1', 'idle'], ['old-runner', 'offline'],
    ]);
  });
  it('builds os label with arch or omits it', () => {
    const by = Object.fromEntries(mapRunners(raw, []).map((r) => [r.name, r.os]));
    expect(by['win-runner-1']).toBe('Windows · X64');
    expect(by['linux-runner-1']).toBe('Linux · ARM64');
    expect(by['a-runner']).toBe('macOS · ARM');
    expect(by['old-runner']).toBe('Linux');
  });
  it('offline wins over busy', () => {
    const r = mapRunners([{ ...raw[0], status: 'offline' }], []);
    expect(r[0].state).toBe('offline');
  });
  it('matches busy runner to in-progress run by runnerName', () => {
    const out = mapRunners(raw, [run()]);
    expect(out.find((r) => r.name === 'win-runner-1')!.job).toEqual({ repo: 'acme/app', workflow: 'ci.yml', runNumber: 41, startedAt: 5000 });
    expect(out.find((r) => r.name === 'a-runner')!.job).toBeNull();
  });
  it('dedupes by id and exposes label names', () => {
    const out = mapRunners([...raw, raw[0]], []);
    expect(out).toHaveLength(4);
    expect(out[0].labels).toContain('windows');
  });
});
