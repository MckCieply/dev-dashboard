import type {
  CollectorName, CollectorStatus, DashboardState, HookEvent, PullRequest, QueuedRun, RateInfo, Runner, Session,
} from './types.js';
import { applyHookEvent, sweep, type Sessions } from './sessions/machine.js';

export type Listener = (next: DashboardState, prev: DashboardState) => void;

const RANK: Record<Session['state'], number> = { waiting: 0, working: 1, unknown: 2 };

function sortSessions(sessions: Sessions): Session[] {
  return Object.values(sessions).map((s) => ({ ...s })).sort((a, b) => {
    if (RANK[a.state] !== RANK[b.state]) return RANK[a.state] - RANK[b.state];
    if (a.state === 'waiting' && a.since !== b.since) return a.since - b.since;
    return a.project.localeCompare(b.project) || a.id.localeCompare(b.id);
  });
}

export class Store {
  private sessions: Sessions;
  private runners: Runner[] = [];
  private queue: QueuedRun[] = [];
  private prs: PullRequest[] = [];
  private repos: string[] = [];
  private rate: RateInfo | null = null;
  private readonly toasts: boolean;
  private readonly now: () => number;
  private readonly listeners = new Set<Listener>();
  private collectors: Record<CollectorName, CollectorStatus> = {
    sessions: { ok: true, lastSuccessAt: null, error: null },
    repos: { ok: false, lastSuccessAt: null, error: null },
    runners: { ok: false, lastSuccessAt: null, error: null },
    queue: { ok: false, lastSuccessAt: null, error: null },
    prs: { ok: false, lastSuccessAt: null, error: null },
  };

  constructor(init: { sessions?: Sessions; toasts: boolean; now?: () => number }) {
    this.sessions = init.sessions ?? {};
    this.toasts = init.toasts;
    this.now = init.now ?? Date.now;
  }

  get(): DashboardState {
    return {
      sessions: sortSessions(this.sessions),
      runners: this.runners.map((r) => ({ ...r })),
      queue: this.queue.map((q) => ({ ...q })),
      prs: this.prs.map((p) => ({ ...p })),
      repos: [...this.repos],
      collectors: {
        sessions: { ...this.collectors.sessions },
        repos: { ...this.collectors.repos },
        runners: { ...this.collectors.runners },
        queue: { ...this.collectors.queue },
        prs: { ...this.collectors.prs },
      },
      rate: this.rate ? { ...this.rate } : null,
      toasts: this.toasts,
      now: this.now(),
    };
  }

  getSessions(): Sessions { return this.sessions; }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private change(mutate: () => void): void {
    const prev = this.get();
    mutate();
    const next = this.get();
    for (const fn of [...this.listeners]) fn(next, prev);
  }

  applyHook(ev: HookEvent): void {
    const t = this.now();
    const updated = applyHookEvent(this.sessions, ev, t);
    if (updated === this.sessions) return;
    this.change(() => {
      this.sessions = updated;
      this.collectors.sessions = { ok: true, lastSuccessAt: t, error: null };
    });
  }

  sweepSessions(): void {
    const swept = sweep(this.sessions, this.now());
    if (swept === this.sessions) return;
    this.change(() => { this.sessions = swept; });
  }

  setRepos(repos: string[]): void { this.change(() => { this.repos = repos; }); }
  setRunners(r: Runner[]): void { this.change(() => { this.runners = r; }); }
  setQueue(q: QueuedRun[]): void { this.change(() => { this.queue = q; }); }
  setPrs(p: PullRequest[]): void { this.change(() => { this.prs = p; }); }
  setCollector(name: CollectorName, status: Partial<CollectorStatus>): void {
    this.change(() => { this.collectors[name] = { ...this.collectors[name], ...status }; });
  }
  setRate(r: RateInfo | null): void { this.change(() => { this.rate = r; }); }
}
