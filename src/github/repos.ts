export interface RawRepo { full_name: string; pushed_at: string | null; archived: boolean; owner: { login: string; type: string } }

export const REPOS_PATH = '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member';

const DAY_MS = 86_400_000;

export function filterActiveRepos(repos: RawRepo[], now: number, days: number): string[] {
  const cutoff = now - days * DAY_MS;
  return repos
    .filter((r) => !r.archived && r.pushed_at !== null)
    .map((r) => ({ name: r.full_name, at: Date.parse(r.pushed_at as string) }))
    .filter((r) => Number.isFinite(r.at) && r.at >= cutoff)
    .sort((a, b) => b.at - a.at)
    .map((r) => r.name);
}

export function orgsFromRepos(repos: RawRepo[]): string[] {
  const out = new Set<string>();
  for (const r of repos) if (r.owner.type === 'Organization') out.add(r.owner.login);
  return [...out];
}
