import type { QueuedRun, RunState } from '../types.js';

export interface RawRun {
  id: number; name: string | null; path: string; run_number: number; head_branch: string | null; status: string;
  created_at: string; run_started_at?: string | null; html_url: string; repository: { full_name: string };
}
export interface RawJob { id: number; run_id: number; status: string; labels: string[]; runner_name: string | null; started_at: string | null }

const QUEUED = new Set(['queued', 'waiting', 'pending', 'requested']);

function stateOf(status: string): RunState | null {
  if (QUEUED.has(status)) return 'queued';
  if (status === 'in_progress') return 'in_progress';
  return null;
}

export function mapRuns(runs: RawRun[], jobsByRun: Record<number, RawJob[]>): QueuedRun[] {
  const out: QueuedRun[] = [];
  for (const r of runs) {
    const state = stateOf(r.status);
    if (!state) continue;
    const jobs = jobsByRun[r.id] ?? [];
    const labels = new Set<string>();
    for (const j of jobs) {
      if (j.status === 'completed') continue;
      for (const l of j.labels) if (l !== 'self-hosted') labels.add(l);
    }
    const running = jobs.find((j) => j.status === 'in_progress');
    const started = r.run_started_at ? Date.parse(r.run_started_at) : NaN;
    out.push({
      id: r.id,
      repo: r.repository.full_name,
      workflow: r.path.split('/').pop() ?? r.path,
      runNumber: r.run_number,
      branch: r.head_branch ?? '',
      state,
      createdAt: Date.parse(r.created_at),
      startedAt: state === 'in_progress' && Number.isFinite(started) ? started : null,
      labels: [...labels],
      runnerName: running?.runner_name ?? null,
      url: r.html_url,
    });
  }
  return out.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'in_progress' ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}
