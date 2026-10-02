import { describe, it, expect } from 'bun:test';
import { createGitHubTuningFetcher } from '../tuning';

const SOURCE = { owner: 'example-org', repo: 'example-private', ref: 'main', path: 'tuning' };
const SHA = '0123456789abcdef0123456789abcdef01234567';

function fakeFetch(routes: Record<string, () => Response>) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    return routes[key]();
  }) as typeof fetch;
  return { impl, seen };
}

describe('createGitHubTuningFetcher', () => {
  it('pins to the commit sha, lists the directory and reads each file', async () => {
    const { impl, seen } = fakeFetch({
      '/commits/main': () => new Response(SHA),
      [`/contents/tuning?ref=${SHA}`]: () =>
        Response.json([
          { name: 'role.builder.md', type: 'file', size: 10 },
          { name: 'policy.ci-retry.json', type: 'file', size: 10 },
          { name: 'nested', type: 'dir', size: 0 },
          { name: 'notes.txt', type: 'file', size: 10 },
          { name: 'role.huge.md', type: 'file', size: 10_000_000 },
        ]),
      '/contents/tuning/role.builder.md': () => new Response('# prompt'),
      '/contents/tuning/policy.ci-retry.json': () => new Response('{"retries":3}'),
    });
    const fetcher = createGitHubTuningFetcher({ getToken: async () => 'tok', fetchImpl: impl });
    const out = await fetcher(SOURCE);
    expect(out.version).toBe(SHA.slice(0, 12));
    expect(out.files).toEqual({
      'role.builder.md': '# prompt',
      'policy.ci-retry.json': '{"retries":3}',
    });
    expect(seen.every((s) => s.headers.Authorization === 'Bearer tok')).toBe(true);
    expect(seen.some((s) => s.url.includes('notes.txt') || s.url.includes('role.huge.md'))).toBe(false);
  });

  it('throws when no installation token is available', async () => {
    const fetcher = createGitHubTuningFetcher({ getToken: async () => null, fetchImpl: fakeFetch({}).impl });
    await expect(fetcher(SOURCE)).rejects.toThrow();
  });

  it('throws on a non-ok response', async () => {
    const { impl } = fakeFetch({}); // everything 404s
    const fetcher = createGitHubTuningFetcher({ getToken: async () => 'tok', fetchImpl: impl });
    await expect(fetcher(SOURCE)).rejects.toThrow();
  });

  it('does not put the token in the thrown error', async () => {
    const { impl } = fakeFetch({});
    const fetcher = createGitHubTuningFetcher({ getToken: async () => 'tok-abc-123', fetchImpl: impl });
    const err = await fetcher(SOURCE).catch((e) => e as Error);
    expect(String(err.message)).not.toContain('tok-abc-123');
  });
});
