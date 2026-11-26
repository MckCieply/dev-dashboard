import { describe, it, expect } from 'vitest';
import { GitHubClient, GitHubError, resolveToken } from '../../src/github/client.js';

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    return r;
  }) as typeof fetch;
  return { fn, calls };
}
const hdr = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

describe('GitHubClient', () => {
  it('sends If-None-Match after an ETag and returns cached body on 304', async () => {
    const { fn, calls } = fakeFetch([
      new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { ETag: '"abc"' } }),
      new Response(null, { status: 304 }),
    ]);
    const c = new GitHubClient({ token: 't', fetch: fn });
    expect(await c.rest('/x')).toEqual({ a: 1 });
    expect(hdr(calls[0].init, 'if-none-match')).toBeNull();
    expect(await c.rest('/x')).toEqual({ a: 1 });
    expect(hdr(calls[1].init, 'if-none-match')).toBe('"abc"');
    expect(calls[0].url).toBe('https://api.github.com/x');
  });

  it('sends the standard headers', async () => {
    const { fn, calls } = fakeFetch([new Response('{}', { status: 200 })]);
    await new GitHubClient({ token: 'tok', fetch: fn }).rest('/x');
    expect(hdr(calls[0].init, 'authorization')).toBe('Bearer tok');
    expect(hdr(calls[0].init, 'accept')).toBe('application/vnd.github+json');
    expect(hdr(calls[0].init, 'x-github-api-version')).toBe('2022-11-28');
    expect(hdr(calls[0].init, 'user-agent')).toBe('dev-dashboard');
  });

  it('throws GitHubError with status on non-2xx', async () => {
    const { fn } = fakeFetch([new Response('no', { status: 401, statusText: 'Unauthorized' })]);
    const err = await new GitHubClient({ token: 't', fetch: fn }).rest('/x').then(() => { throw new Error('expected throw'); }, (e: GitHubError) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('401 Unauthorized');
  });

  it('parses rate headers (reset seconds -> ms)', async () => {
    const { fn } = fakeFetch([
      new Response('{}', { status: 200, headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1700000000' } }),
    ]);
    const c = new GitHubClient({ token: 't', fetch: fn });
    expect(c.lastRate()).toBeNull();
    await c.rest('/x');
    expect(c.lastRate()).toEqual({ remaining: 4999, limit: 5000, resetAt: 1_700_000_000_000 });
  });

  it('graphql throws on errors and returns data otherwise, recording rate', async () => {
    const rate = { 'x-ratelimit-remaining': '10', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '100' };
    const { fn, calls } = fakeFetch([
      new Response(JSON.stringify({ errors: [{ message: 'x' }] }), { status: 200 }),
      new Response(JSON.stringify({ data: { v: 1 } }), { status: 200, headers: rate }),
    ]);
    const c = new GitHubClient({ token: 't', fetch: fn });
    const err = await c.graphql('q').then(() => { throw new Error('expected throw'); }, (e: GitHubError) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(200);
    expect(err.message).toBe('x');
    expect(await c.graphql('q')).toEqual({ v: 1 });
    expect(calls[1].url).toBe('https://api.github.com/graphql');
    expect(calls[1].init.method).toBe('POST');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ query: 'q' });
    expect(c.lastRate()).toEqual({ remaining: 10, limit: 5000, resetAt: 100_000 });
  });
});

describe('resolveToken', () => {
  it('uses gh output trimmed', async () => {
    expect(await resolveToken({}, async () => ' ghtok\n')).toBe('ghtok');
  });
  it('falls back to GITHUB_TOKEN then GH_TOKEN when gh throws or is empty', async () => {
    const boom = async () => { throw new Error('no gh'); };
    expect(await resolveToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }, boom)).toBe('a');
    expect(await resolveToken({ GH_TOKEN: 'b' }, async () => '\n')).toBe('b');
  });
  it('returns null when nothing available', async () => {
    expect(await resolveToken({}, async () => { throw new Error('x'); })).toBeNull();
  });
});
