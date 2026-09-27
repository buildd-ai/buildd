import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * Rankings fetch: the team's own key, once a day after 03:00 UTC, no retry,
 * and a failed view writes nothing.
 */

const cache = new Map<string, { value: any; expiresAt: Date | null }>();
let cred: { key: string } | null = { key: 'sk-or-team' };
const credCalls: any[] = [];

function selectBuilder() {
  const b: any = {
    from() { return b; },
    where() { return b; },
    limit() { return b; },
    then(res: (v: unknown) => unknown) {
      return Promise.resolve([...cache.entries()].map(([key, v]) => ({ key, value: v.value, expiresAt: v.expiresAt }))).then(res);
    },
  };
  return b;
}

mock.module('../db/client', () => ({
  db: {
    select: () => selectBuilder(),
    insert: () => ({
      values: (v: any) => ({ onConflictDoUpdate: async () => { cache.set(v.key, { value: v.value, expiresAt: v.expiresAt }); } }),
    }),
  },
}));
mock.module('../inference-keys', () => ({
  resolveInferenceCredential: async (o: any) => { credCalls.push(o); return cred; },
}));

const { refreshTeamRankings } = await import('../openrouter-rankings-source');
const { rankingsAttemptKey, rankingsCacheKey } = await import('../openrouter-rankings');

const catalog = [{
  id: 'claude-sonnet-5', canonicalId: null, openRouterId: 'anthropic/claude-sonnet-5', permaslug: 'anthropic/claude-sonnet-5',
  provider: 'anthropic' as const, displayName: 'x', contextLength: 1, created: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
}];
const NOW = new Date('2026-09-27T04:00:00Z');
const okBody = { data: [{ date: '2026-09-26', model_permaslug: 'anthropic/claude-sonnet-5', total_tokens: '10' }], meta: { as_of: '2026-09-26T02:00:00Z' } };

function fetcher(status: number, body: unknown = okBody) {
  const calls: Array<{ url: string; auth: string }> = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, auth: init.headers.authorization });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

beforeEach(() => { cache.clear(); cred = { key: 'sk-or-team' }; credCalls.length = 0; });

describe('refreshTeamRankings', () => {
  it('fetches the three views on the team\'s own key and stores only percentiles', async () => {
    const { f, calls } = fetcher(200);
    const r = await refreshTeamRankings({ teamId: 'team-1', catalog, now: NOW, fetchImpl: f });
    expect(r.status).toBe('fetched');
    expect(r.written).toEqual(['tool_calling', 'programming', 'text']);
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.auth === 'Bearer sk-or-team')).toBe(true);
    expect(credCalls[0]).toEqual({ provider: 'openrouter', teamId: 'team-1' });
    const stored = cache.get(rankingsCacheKey('team-1', 'text'))!;
    expect(stored.value).toEqual({ asOf: '2026-09-26T02:00:00Z', startDate: null, endDate: null, scores: { 'claude-sonnet-5': 1 } });
    expect(JSON.stringify(stored.value)).not.toContain('total_tokens');
    expect(stored.expiresAt!.getTime() - NOW.getTime()).toBe(7 * 86_400_000);
  });

  for (const status of [400, 401, 429]) {
    it(`a ${status} writes no scores and is not retried that day`, async () => {
      const { f, calls } = fetcher(status, { error: 'x' });
      const r = await refreshTeamRankings({ teamId: 'team-1', catalog, now: NOW, fetchImpl: f });
      expect(r.written).toEqual([]);
      expect(r.failed.map(x => x.status)).toEqual([status, status, status]);
      expect(cache.has(rankingsCacheKey('team-1', 'text'))).toBe(false);
      const again = await refreshTeamRankings({ teamId: 'team-1', catalog, now: new Date('2026-09-27T05:00:00Z'), fetchImpl: f });
      expect(again.status).toBe('not_due');
      expect(calls).toHaveLength(3);
    });
  }

  it('without an OpenRouter key, fetches nothing', async () => {
    cred = null;
    const { f, calls } = fetcher(200);
    const r = await refreshTeamRankings({ teamId: 'team-1', catalog, now: NOW, fetchImpl: f });
    expect(r.status).toBe('no_key');
    expect(calls).toHaveLength(0);
    expect(cache.has(rankingsAttemptKey('team-1'))).toBe(false);
  });

  it('before 03:00 UTC, does nothing', async () => {
    const { f, calls } = fetcher(200);
    const r = await refreshTeamRankings({ teamId: 'team-1', catalog, now: new Date('2026-09-27T02:59:00Z'), fetchImpl: f });
    expect(r.status).toBe('not_due');
    expect(calls).toHaveLength(0);
    expect(credCalls).toHaveLength(0);
  });
});
