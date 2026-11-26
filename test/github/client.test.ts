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

  it('tracks rate per resource and lastRate returns the lowest remaining', async () => {
    const h = (resource: string, rem: string) => ({ 'x-ratelimit-resource': resource, 'x-ratelimit-remaining': rem, 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '100' });
    const { fn } = fakeFetch([
      new Response('{}', { status: 200, headers: h('core', '300') }),
      new Response(JSON.stringify({ data: {} }), { status: 200, headers: h('graphql', '4900') }),
    ]);
    const c = new GitHubClient({ token: 't', fetch: fn });
    await c.rest('/x');
    await c.graphql('q');
    expect(c.lastRate()).toEqual({ remaining: 300, limit: 5000, resetAt: 100_000 });
  });

  it('falls back to core for rest and graphql for graphql when resource header missing', async () => {
    const h = (rem: string) => ({ 'x-ratelimit-remaining': rem, 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '100' });
    const { fn } = fakeFetch([
      new Response('{}', { status: 200, headers: h('300') }),
      new Response(JSON.stringify({ data: {} }), { status: 200, headers: h('4900') }),
    ]);
    const c = new GitHubClient({ token: 't', fetch: fn });
    await c.rest('/x');
    await c.graphql('q');
    expect(c.lastRate()!.remaining).toBe(300);
  });

  it('passes an abort signal and a timeout surfaces as an error', async () => {
    const fn = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
      init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason));
    })) as typeof fetch;
    const c = new GitHubClient({ token: 't', fetch: fn, timeoutMs: 20 });
    await expect(c.rest('/x')).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(c.graphql('q')).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('graphql with partial errors but data returns data; no data throws', async () => {
    const { fn } = fakeFetch([
      new Response(JSON.stringify({ data: { r0: null, r1: { a: 1 } }, errors: [{ message: 'not found' }] }), { status: 200 }),
      new Response(JSON.stringify({ data: null, errors: [{ message: 'bad' }] }), { status: 200 }),
    ]);
    const c = new GitHubClient({ token: 't', fetch: fn });
    expect(await c.graphql('q')).toEqual({ r0: null, r1: { a: 1 } });
    await expect(c.graphql('q')).rejects.toThrow('bad');
  });

  it('bounds the etag cache, evicting the least recently used', async () => {
    const etagged = (n: string) => new Response('{}', { status: 200, headers: { ETag: `"${n}"` } });
    const { fn, calls } = fakeFetch([etagged('a'), etagged('b'), new Response(null, { status: 304 }), etagged('c'), etagged('a2'), etagged('b2')]);
    const c = new GitHubClient({ token: 't', fetch: fn, maxCacheEntries: 2 });
    await c.rest('/a'); await c.rest('/b');
    await c.rest('/a'); // hit, refreshes /a
    await c.rest('/c'); // evicts /b
    await c.rest('/a');
    await c.rest('/b');
    expect(hdr(calls[2].init, 'if-none-match')).toBe('"a"');
    expect(hdr(calls[4].init, 'if-none-match')).toBe('"a"');
    expect(hdr(calls[5].init, 'if-none-match')).toBeNull();
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
