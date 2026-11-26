import type { Config } from '../config.js';
import type { Store } from '../store.js';
import type { CollectorName, QueuedRun } from '../types.js';
import { GitHubClient, GitHubError } from './client.js';
import { filterActiveRepos, orgsFromRepos, REPOS_PATH, type RawRepo } from './repos.js';
import { mapRunners, type RawRunner } from './runners.js';
import { mapRuns, type RawJob, type RawRun } from './queue.js';
import { buildPrQuery, mapPrs } from './prs.js';

const NO_TOKEN = 'brak tokenu GitHub';
const LOW_RATE = 500;

function errText(e: unknown): string {
  return e instanceof GitHubError ? `błąd ${e.status}` : 'błąd sieci';
}

export class GitHubPoller {
  private readonly client: GitHubClient | null;
  private readonly store: Store;
  private readonly config: Config;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private rawRepos: RawRepo[] = [];
  private reposTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: { client: GitHubClient | null; store: Store; config: Config; now?: () => number; log?: (msg: string) => void }) {
    this.client = opts.client;
    this.store = opts.store;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  private ok(name: CollectorName): void {
    this.store.setCollector(name, { ok: true, lastSuccessAt: this.now(), error: null });
  }

  private fail(name: CollectorName, error: string): void {
    this.store.setCollector(name, { ok: false, error });
  }

  private noToken(): void {
    for (const n of ['repos', 'runners', 'queue', 'prs'] as const) this.fail(n, NO_TOKEN);
  }

  async refreshRepos(): Promise<void> {
    if (!this.client) { this.noToken(); return; }
    try {
      this.rawRepos = await this.client.rest<RawRepo[]>(REPOS_PATH);
      this.store.setRepos(filterActiveRepos(this.rawRepos, this.now(), this.config.activeDays));
      this.ok('repos');
    } catch (e) {
      this.log(`repos: ${String(e)}`);
      this.fail('repos', errText(e));
    }
  }

  async pollOnce(): Promise<void> {
    const client = this.client;
    if (!client) { this.noToken(); return; }
    const repos = this.store.get().repos;
    const inProgress = await this.pollQueue(client, repos);
    await this.pollRunners(client, repos, inProgress);
    await this.pollPrs(client, repos);
    const rate = client.lastRate();
    this.store.setRate(rate ? { ...rate, slowed: rate.remaining < LOW_RATE } : null);
  }

  private async pollQueue(client: GitHubClient, repos: string[]): Promise<QueuedRun[]> {
    try {
      const runs: RawRun[] = [];
      const jobsByRun: Record<number, RawJob[]> = {};
      let failures = 0;
      let firstErr: unknown = null;
      for (const repo of repos) {
        try {
          const batch: RawRun[] = [];
          for (const status of ['queued', 'in_progress']) {
            const res = await client.rest<{ workflow_runs: RawRun[] }>(`/repos/${repo}/actions/runs?status=${status}&per_page=50`);
            batch.push(...res.workflow_runs);
          }
          const repoJobs: Record<number, RawJob[]> = {};
          for (const run of batch) {
            const res = await client.rest<{ jobs: RawJob[] }>(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=50`);
            repoJobs[run.id] = res.jobs;
          }
          runs.push(...batch);
          Object.assign(jobsByRun, repoJobs);
        } catch (e) {
          failures++;
          firstErr ??= e;
          this.log(`queue ${repo}: ${String(e)}`);
        }
      }
      if (repos.length > 0 && failures === repos.length) {
        this.fail('queue', errText(firstErr));
        return this.store.get().queue.filter((q) => q.state === 'in_progress');
      }
      const mapped = mapRuns(runs, jobsByRun);
      this.store.setQueue(mapped);
      if (failures > 0) this.fail('queue', errText(firstErr)); else this.ok('queue');
      return mapped.filter((q) => q.state === 'in_progress');
    } catch (e) {
      this.log(`queue: ${String(e)}`);
      this.fail('queue', errText(e));
      return this.store.get().queue.filter((q) => q.state === 'in_progress');
    }
  }

  private async pollRunners(client: GitHubClient, repos: string[], inProgress: QueuedRun[]): Promise<void> {
    try {
      const orgs = [...new Set([...this.config.orgs, ...orgsFromRepos(this.rawRepos)])];
      const paths = [
        ...repos.map((r) => `/repos/${r}/actions/runners?per_page=100`),
        ...orgs.map((o) => `/orgs/${o}/actions/runners?per_page=100`),
      ];
      const raw: RawRunner[] = [];
      let successes = 0;
      let firstErr: unknown = null;
      let hardErr: unknown = null;
      for (const p of paths) {
        try {
          const res = await client.rest<{ runners: RawRunner[] }>(p);
          raw.push(...res.runners);
          successes++;
        } catch (e) {
          firstErr ??= e;
          const ignorable = e instanceof GitHubError && (e.status === 403 || e.status === 404);
          if (!ignorable) hardErr ??= e;
          this.log(`runners ${p}: ${String(e)}`);
        }
      }
      if (paths.length > 0 && successes === 0) {
        this.fail('runners', errText(firstErr));
        return;
      }
      this.store.setRunners(mapRunners(raw, inProgress));
      if (hardErr) this.fail('runners', errText(hardErr)); else this.ok('runners');
    } catch (e) {
      this.log(`runners: ${String(e)}`);
      this.fail('runners', errText(e));
    }
  }

  private async pollPrs(client: GitHubClient, repos: string[]): Promise<void> {
    try {
      if (repos.length === 0) {
        this.store.setPrs([]);
      } else {
        const data = await client.graphql<unknown>(buildPrQuery(repos));
        this.store.setPrs(mapPrs(data, repos));
      }
      this.ok('prs');
    } catch (e) {
      this.log(`prs: ${String(e)}`);
      this.fail('prs', errText(e));
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const reposLoop = async (): Promise<void> => {
      await this.refreshRepos();
      if (this.running) this.reposTimer = setTimeout(() => { void reposLoop(); }, this.config.reposRefreshMs);
    };
    const pollLoop = async (): Promise<void> => {
      await this.pollOnce();
      if (!this.running) return;
      const slow = this.store.get().rate?.slowed === true;
      this.pollTimer = setTimeout(() => { void pollLoop(); }, slow ? this.config.slowPollMs : this.config.pollMs);
    };
    void reposLoop().then(() => pollLoop());
  }

  stop(): void {
    this.running = false;
    if (this.reposTimer) clearTimeout(this.reposTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.reposTimer = this.pollTimer = null;
  }
}
