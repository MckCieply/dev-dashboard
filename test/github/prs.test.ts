import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPrQuery, mapPrs } from '../../src/github/prs.js';

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
