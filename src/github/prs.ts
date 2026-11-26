import type { ChecksState, MergeState, PullRequest, ReviewState } from '../types.js';

const PR_FIELDS = `id number title url isDraft reviewDecision mergeable mergeStateStatus
commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } }`;

export function buildPrQuery(repos: string[]): string {
  const parts = repos.map((full, i) => {
    const [owner, ...rest] = full.split('/');
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(rest.join('/'))}) { pullRequests(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } } }`;
  });
  return `query { ${parts.join(' ')} rateLimit { remaining limit resetAt } }`;
}

interface Ctx { __typename?: string; status?: string; conclusion?: string | null; state?: string }
interface RawPr {
  id: string; number: number; title: string; url: string; isDraft: boolean;
  reviewDecision: string | null; mergeable: string; mergeStateStatus: string;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state: string; contexts?: { totalCount?: number; nodes?: Ctx[] } } | null } }[] };
}

const CHECK_PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CHECK_FAIL = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

function classify(c: Ctx): 'passed' | 'failed' | 'pending' {
  if (c.__typename === 'StatusContext') {
    if (c.state === 'SUCCESS') return 'passed';
    if (c.state === 'FAILURE' || c.state === 'ERROR') return 'failed';
    return 'pending';
  }
  const k = c.conclusion ?? '';
  if (CHECK_PASS.has(k)) return 'passed';
  if (CHECK_FAIL.has(k)) return 'failed';
  return 'pending';
}

function mapChecks(pr: RawPr): PullRequest['checks'] {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup) return { state: 'none', passed: 0, failed: 0, total: 0 };
  const nodes = rollup.contexts?.nodes ?? [];
  let passed = 0, failed = 0;
  for (const n of nodes) {
    const c = classify(n);
    if (c === 'passed') passed++;
    else if (c === 'failed') failed++;
  }
  const state: ChecksState = rollup.state === 'SUCCESS' ? 'pass' : rollup.state === 'FAILURE' || rollup.state === 'ERROR' ? 'fail' : 'pending';
  return { state, passed, failed, total: rollup.contexts?.totalCount ?? nodes.length };
}

function mapReview(pr: RawPr): ReviewState {
  if (pr.isDraft) return 'draft';
  switch (pr.reviewDecision) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes_requested';
    case 'REVIEW_REQUIRED': return 'review_required';
    default: return 'none';
  }
}

function mapMerge(pr: RawPr): MergeState {
  if (pr.isDraft) return 'draft';
  if (pr.mergeable === 'CONFLICTING') return 'conflict';
  switch (pr.mergeStateStatus) {
    case 'CLEAN': case 'HAS_HOOKS': return 'ready';
    case 'BLOCKED': case 'BEHIND': case 'UNSTABLE': case 'DIRTY': return 'blocked';
    default: return 'unknown';
  }
}

export function mapPrs(data: unknown, repos: string[]): PullRequest[] {
  const out: PullRequest[] = [];
  if (!data || typeof data !== 'object') return out;
  const d = data as Record<string, { pullRequests?: { nodes?: RawPr[] } } | null | undefined>;
  repos.forEach((repo, i) => {
    const nodes = d[`r${i}`]?.pullRequests?.nodes;
    if (!nodes) return;
    for (const pr of nodes) {
      out.push({
        id: pr.id, repo, number: pr.number, title: pr.title, url: pr.url, draft: pr.isDraft,
        checks: mapChecks(pr), review: mapReview(pr), merge: mapMerge(pr),
      });
    }
  });
  const group = (p: PullRequest): number => (p.checks.state === 'fail' ? 0 : p.merge === 'ready' ? 1 : 2);
  return out.sort((a, b) => group(a) - group(b) || a.repo.localeCompare(b.repo) || b.number - a.number);
}
