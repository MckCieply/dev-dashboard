import { describe, it, expect } from 'vitest';
import { filterActiveRepos, orgsFromRepos, REPOS_PATH, type RawRepo } from '../../src/github/repos.js';

const DAY = 86_400_000;
const now = 1_800_000_000_000;
const repo = (name: string, pushed: number | null, extra: Partial<RawRepo> = {}): RawRepo => ({
  full_name: name,
  pushed_at: pushed === null ? null : new Date(pushed).toISOString(),
  archived: false,
  owner: { login: name.split('/')[0], type: 'User' },
  ...extra,
});

describe('filterActiveRepos', () => {
  it('includes exactly 14 days, excludes 14 days + 1 ms', () => {
    const r = [repo('a/in', now - 14 * DAY), repo('a/out', now - 14 * DAY - 1)];
    expect(filterActiveRepos(r, now, 14)).toEqual(['a/in']);
  });
  it('excludes archived and null pushed_at', () => {
    const r = [repo('a/arch', now, { archived: true }), repo('a/null', null), repo('a/ok', now)];
    expect(filterActiveRepos(r, now, 14)).toEqual(['a/ok']);
  });
  it('sorts newest push first', () => {
    const r = [repo('a/old', now - 3 * DAY), repo('a/new', now - 1 * DAY), repo('a/mid', now - 2 * DAY)];
    expect(filterActiveRepos(r, now, 14)).toEqual(['a/new', 'a/mid', 'a/old']);
  });
});

describe('orgsFromRepos', () => {
  it('returns unique organization owners only', () => {
    const org = { login: 'acme', type: 'Organization' };
    const r = [repo('acme/a', now, { owner: org }), repo('acme/b', now, { owner: org }), repo('me/c', now)];
    expect(orgsFromRepos(r)).toEqual(['acme']);
  });
});

describe('REPOS_PATH', () => {
  it('matches the contract', () => {
    expect(REPOS_PATH).toBe('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
  });
});
