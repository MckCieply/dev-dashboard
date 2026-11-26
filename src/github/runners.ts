import type { QueuedRun, Runner, RunnerState } from '../types.js';

export interface RawRunner { id: number; name: string; os: string; status: 'online' | 'offline'; busy: boolean; labels: { name: string }[] }

const ARCH_LABELS = ['X64', 'ARM64', 'ARM'];
const RANK: Record<RunnerState, number> = { busy: 0, idle: 1, offline: 2 };

export function mapRunners(raw: RawRunner[], inProgress: QueuedRun[]): Runner[] {
  const seen = new Set<number>();
  const out: Runner[] = [];
  for (const r of raw) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const labels = r.labels.map((l) => l.name);
    const arch = labels.find((l) => ARCH_LABELS.includes(l));
    const state: RunnerState = r.status === 'offline' ? 'offline' : r.busy ? 'busy' : 'idle';
    const run = inProgress.find((q) => q.runnerName === r.name);
    out.push({
      id: r.id,
      name: r.name,
      os: arch ? `${r.os} · ${arch}` : r.os,
      labels,
      state,
      job: run ? { repo: run.repo, workflow: run.workflow, runNumber: run.runNumber, startedAt: run.startedAt ?? run.createdAt } : null,
    });
  }
  return out.sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name));
}
