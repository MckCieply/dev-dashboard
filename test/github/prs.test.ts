import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPrQuery, mapPrs, mapMerged } from '../../src/github/prs.js';

const data = JSON.parse(readFileSync(new URL('../fixtures/prs-graphql.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const repos = ['acme/app', 'acme/noaccess'];

describe('buildPrQuery', () => {
  it('uses aliases and includes rateLimit', () => {
    const q = buildPrQuery(['a/b', 'c/d']);
    expect(q).toContain('r0: repository(owner: "a", name: "b")');
    expect(q).toContain('r1: repository(owner: "c", name: "d")');
    expect(q).toContain('rateLimit { remaining limit resetAt }');
    expect(q).toContain('states: OPEN');
  });
  it('escapes quotes in owner/name', () => {
    const q = buildPrQuery(['a"b/c"d']);
    expect(q).toContain('owner: "a\\"b"');
    expect(q).toContain('name: "c\\"d"');
  });
});

describe('mapPrs', () => {
  const out = mapPrs(data, repos);
  const by = (n: number) => out.find((p) => p.number === n)!;
  it('skips null repo alias and sorts fail, ready, rest (number desc)', () => {
    expect(out.map((p) => p.number)).toEqual([13, 12, 15, 14]);
  });
  it('maps passing PR', () => {
    expect(by(12)).toMatchObject({
      id: 'PR_1', repo: 'acme/app', title: 'Add "login" & <b>', draft: false,
      checks: { state: 'pass', passed: 2, failed: 0, total: 2 }, review: 'approved', merge: 'ready',
    });
  });
  it('maps failing PR: counts and blocked', () => {
    expect(by(13)).toMatchObject({
      checks: { state: 'fail', passed: 1, failed: 1, total: 3 }, review: 'changes_requested', merge: 'blocked',
    });
  });
  it('null rollup -> none; null review -> none; conflicting -> conflict', () => {
    expect(by(14)).toMatchObject({ checks: { state: 'none', passed: 0, failed: 0, total: 0 }, review: 'none', merge: 'conflict' });
  });
  it('draft PR: draft review and merge, pending checks', () => {
    expect(by(15)).toMatchObject({ draft: true, review: 'draft', merge: 'draft', checks: { state: 'pending', passed: 0, failed: 0, total: 1 } });
  });
  it('tolerates missing data', () => {
    expect(mapPrs(null, repos)).toEqual([]);
  });
});

describe('labels and needs-human', () => {
  const raw = (number: number, labels: string[], extra: object = {}) => ({
    id: `L${number}`, number, title: 't', url: 'u', isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', labels: { nodes: labels.map((name) => ({ name })) }, ...extra,
  });
  const map = (labels: string[]) => mapPrs({ r0: { pullRequests: { nodes: [raw(1, labels)] } } }, ['a/b'])[0];

  it('asks for labels', () => {
    expect(buildPrQuery(['a/b'])).toContain('labels(first: 20)');
  });
  it('reads label names', () => {
    expect(map(['bug', 'needs-human']).labels).toEqual(['bug', 'needs-human']);
  });
  it('needsHuman: needs-human without human-approved, any case', () => {
    expect(map(['needs-human']).needsHuman).toBe(true);
    expect(map(['Needs-Human']).needsHuman).toBe(true);
    expect(map(['needs-human', 'Human-Approved']).needsHuman).toBe(false);
    expect(map(['human-approved']).needsHuman).toBe(false);
    expect(map([]).needsHuman).toBe(false);
  });
  it('searches all owners for needs-human PRs', () => {
    const q = buildPrQuery([], ['me', 'org']);
    expect(q).toContain('s0: search(type: ISSUE, first: 50, query: "is:pr is:open archived:false label:needs-human -label:human-approved user:me user:org")');
    expect(q).toContain('repository { nameWithOwner }');
  });
  it('splits owners so each search query stays within 256 characters', () => {
    const owners = Array.from({ length: 20 }, (_, i) => `organisation-number-${i}`);
    const queries = [...buildPrQuery([], owners).matchAll(/query: ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]) as string);
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.every((x) => x.length <= 256)).toBe(true);
    for (const o of owners) expect(queries.some((x) => x.split(' ').includes(`user:${o}`))).toBe(true);
  });
  it('adds search-only PRs once and sorts needs-human first', () => {
    const found = (n: number, repo: string) => raw(n, ['needs-human'], { repository: { nameWithOwner: repo } });
    const out = mapPrs({
      r0: { pullRequests: { nodes: [raw(5, []), raw(1, ['needs-human'])] } },
      s0: { nodes: [found(1, 'a/b'), found(9, 'z/old'), {}] },
    }, ['a/b']);
    expect(out.map((p) => `${p.repo}#${p.number}`)).toEqual(['a/b#1', 'z/old#9', 'a/b#5']);
  });
});
describe('merged PRs', () => {
  it('searches merged PRs since the given day', () => {
    const q = buildPrQuery(['a/b'], ['me'], '2026-11-25');
    expect(q).toContain('m0: search(type: ISSUE, first: 50, query: "is:pr is:merged merged:>=2026-11-25 sort:updated-desc user:me")');
  });
  it('maps search results and skips empty nodes', () => {
    const data = { m0: { nodes: [{ id: 'x', number: 3, title: 'T', repository: { nameWithOwner: 'a/b' } }, {}] } };
    expect(mapMerged(data)).toEqual([{ id: 'x', repo: 'a/b', number: 3, title: 'T' }]);
    expect(mapMerged(null)).toEqual([]);
  });
});