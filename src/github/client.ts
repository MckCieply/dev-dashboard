import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

export type FetchFn = typeof fetch;
export interface RateSnapshot { remaining: number; limit: number; resetAt: number }

export class GitHubClient {
  private token: string;
  private fetchFn: FetchFn;
  private baseUrl: string;
  private cache = new Map<string, { etag: string; body: unknown }>();
  private rate: RateSnapshot | null = null;

  constructor(opts: { token: string; fetch?: FetchFn; baseUrl?: string }) {
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dev-dashboard',
      ...extra,
    };
  }

  private recordRate(res: Response): void {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const limit = res.headers.get('x-ratelimit-limit');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining === null || limit === null || reset === null) return;
    const r = Number(remaining), l = Number(limit), s = Number(reset);
    if (![r, l, s].every(Number.isFinite)) return;
    this.rate = { remaining: r, limit: l, resetAt: s * 1000 };
  }

  async rest<T>(path: string): Promise<T> {
    const url = this.baseUrl + path;
    const cached = this.cache.get(url);
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: this.headers(cached ? { 'If-None-Match': cached.etag } : {}),
    });
    this.recordRate(res);
    if (res.status === 304 && cached) return cached.body as T;
    if (!res.ok) throw new GitHubError(res.status, `${res.status} ${res.statusText}`);
    const body = (await res.json()) as T;
    const etag = res.headers.get('etag');
    if (etag) this.cache.set(url, { etag, body });
    return body;
  }

  async graphql<T>(query: string): Promise<T> {
    const res = await this.fetchFn(this.baseUrl + '/graphql', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query }),
    });
    this.recordRate(res);
    if (!res.ok) throw new GitHubError(res.status, `${res.status} ${res.statusText}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors && json.errors.length > 0) throw new GitHubError(200, json.errors[0].message);
    return json.data as T;
  }

  lastRate(): RateSnapshot | null {
    return this.rate;
  }
}

async function defaultRun(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { timeout: 5000 });
  return String(stdout);
}

export async function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
  run: (cmd: string, args: string[]) => Promise<string> = defaultRun,
): Promise<string | null> {
  try {
    const out = (await run('gh', ['auth', 'token'])).trim();
    if (out) return out;
  } catch { /* fall through */ }
  for (const v of [env.GITHUB_TOKEN, env.GH_TOKEN]) {
    const t = v?.trim();
    if (t) return t;
  }
  return null;
}
