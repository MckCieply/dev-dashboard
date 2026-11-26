import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapRuns, type RawRun, type RawJob } from '../../src/github/queue.js';

const load = <T>(f: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8')) as T;
const queued = load<{ workflow_runs: RawRun[] }>('runs-queued.json').workflow_runs;
const inProg = load<{ workflow_runs: RawRun[] }>('runs-in-progress.json').workflow_runs;
const jobs = load<{ jobs: RawJob[] }>('jobs.json').jobs;

describe('mapRuns', () => {
  it('maps fields, basename workflow, drops self-hosted label and completed jobs', () => {
    const out = mapRuns([queued[0]], { 101: jobs });
    expect(out[0]).toEqual({
      id: 101, repo: 'acme/app', workflow: 'ci.yml', runNumber: 42, branch: 'feat/x', state: 'queued',
      createdAt: Date.parse('2026-11-26T10:00:00Z'), startedAt: null, labels: ['windows'], runnerName: null,
      url: 'https://github.com/acme/app/actions/runs/101',
    });
  });
  it('treats waiting as queued and null branch as empty string', () => {
    const out = mapRuns([queued[1]], {});
    expect(out[0].state).toBe('queued');
    expect(out[0].branch).toBe('');
    expect(out[0].labels).toEqual([]);
  });
  it('in_progress: startedAt from run_started_at and runnerName from first in_progress job', () => {
    const j: RawJob[] = [
      { id: 1, run_id: 99, status: 'completed', labels: [], runner_name: 'x', started_at: null },
      { id: 2, run_id: 99, status: 'in_progress', labels: ['self-hosted', 'windows'], runner_name: 'win-runner-1', started_at: null },
    ];
    const out = mapRuns(inProg, { 99: j });
    expect(out[0].state).toBe('in_progress');
    expect(out[0].startedAt).toBe(Date.parse('2026-11-26T09:41:00Z'));
    expect(out[0].runnerName).toBe('win-runner-1');
  });
  it('drops other statuses', () => {
    expect(mapRuns([{ ...queued[0], status: 'completed' }], {})).toEqual([]);
  });
  it('sorts in_progress first, then queued oldest first', () => {
    const out = mapRuns([queued[0], queued[1], inProg[0]], {});
    expect(out.map((r) => r.id)).toEqual([99, 100, 101]);
  });
});
