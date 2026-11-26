import type { ChecksState, MergedPr, MergeState, PullRequest, ReviewState } from '../types.js';

const PR_FIELDS = `id number title url isDraft reviewDecision mergeable mergeStateStatus
labels(first: 20) { nodes { name } }
commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } }`;

const NEEDS_HUMAN = 'needs-human';
const APPROVED = 'human-approved';
const MAX_SEARCH = 256; // GitHub's limit for one search query

/** One search per chunk of owners, each short enough for GitHub. */
function ownerQueries(base: string, owners: string[]): string[] {
  const out: string[] = [];
  let q = base;
  for (const owner of owners) {
    const next = `${q} user:${owner}`;
    if (next.length > MAX_SEARCH && q !== base) { out.push(q); q = `${base} user:${owner}`; } else q = next;
  }
  if (q !== base) out.push(q);
  return out;
}

function searches(alias: string, base: string, owners: string[], fields: string): string[] {
  return ownerQueries(base, owners).map((q, i) =>
    `${alias}${i}: search(type: ISSUE, first: 50, query: ${JSON.stringify(q)}) { nodes { ... on PullRequest { ${fields} repository { nameWithOwner } } } }`);
}

/** `owners` adds a needs-human search over all their repos; `mergedSince` (YYYY-MM-DD) adds recently merged PRs. */
export function buildPrQuery(repos: string[], owners: string[] = [], mergedSince?: string): string {
  const parts = repos.map((full, i) => {
    const [owner, ...rest] = full.split('/');
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(rest.join('/'))}) { pullRequests(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } } }`;
  });
  parts.push(...searches('s', `is:pr is:open archived:false label:${NEEDS_HUMAN} -label:${APPROVED}`, owners, PR_FIELDS));
  if (mergedSince) parts.push(...searches('m', `is:pr is:merged merged:>=${mergedSince} sort:updated-desc`, owners, 'id number title'));
  return `query { ${parts.join(' ')} rateLimit { remaining limit resetAt } }`;
}

interface Ctx { __typename?: string; status?: string; conclusion?: string | null; state?: string }
interface RawPr {
  id: string; number: number; title: string; url: string; isDraft: boolean;
  reviewDecision: string | null; mergeable: string; mergeStateStatus: string;
  labels?: { nodes?: { name?: string }[] };
  repository?: { nameWithOwner?: string };
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

function toPr(pr: RawPr, repo: string): PullRequest {
  const labels = (pr.labels?.nodes ?? []).map((l) => l.name).filter((n): n is string => typeof n === 'string');
  const has = new Set(labels.map((l) => l.toLowerCase()));
  return {
    id: pr.id, repo, number: pr.number, title: pr.title, url: pr.url, draft: pr.isDraft,
    checks: mapChecks(pr), review: mapReview(pr), merge: mapMerge(pr),
    labels, needsHuman: has.has(NEEDS_HUMAN) && !has.has(APPROVED),
  };
}

/** Nodes of all search aliases with this prefix; empty and repo-less nodes are skipped. */
function searchNodes(data: unknown, prefix: string): { pr: RawPr; repo: string }[] {
  if (!data || typeof data !== 'object') return [];
  const alias = new RegExp(`^${prefix}\\d+$`);
  return Object.entries(data as Record<string, { nodes?: RawPr[] } | null>)
    .filter(([key]) => alias.test(key))
    .flatMap(([, v]) => v?.nodes ?? [])
    .flatMap((pr) => (pr?.id && pr.repository?.nameWithOwner ? [{ pr, repo: pr.repository.nameWithOwner }] : []));
}

export function mapPrs(data: unknown, repos: string[]): PullRequest[] {
  if (!data || typeof data !== 'object') return [];
  const byId = new Map<string, PullRequest>();
  const d = data as Record<string, { pullRequests?: { nodes?: RawPr[] } } | null | undefined>;
  repos.forEach((repo, i) => {
    for (const pr of d[`r${i}`]?.pullRequests?.nodes ?? []) byId.set(pr.id, toPr(pr, repo));
  });
  for (const { pr, repo } of searchNodes(data, 's')) if (!byId.has(pr.id)) byId.set(pr.id, toPr(pr, repo));
  const group = (p: PullRequest): number => (p.needsHuman ? 0 : p.checks.state === 'fail' ? 1 : p.merge === 'ready' ? 2 : 3);
  return [...byId.values()].sort((a, b) => group(a) - group(b) || a.repo.localeCompare(b.repo) || b.number - a.number);
}

export function mapMerged(data: unknown): MergedPr[] {
  const out = new Map(searchNodes(data, 'm').map(({ pr, repo }) => [pr.id, { id: pr.id, repo, number: pr.number, title: pr.title }]));
  return [...out.values()];
}
