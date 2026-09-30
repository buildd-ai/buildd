import { describe, expect, test } from 'bun:test';
import { fetchContainerAnalytics, listRunReportArtifacts } from './eval-client';

type Call = { url: string; init?: RequestInit };

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

function artifact(i: number, updatedAt: string) {
  return { id: `a-${i}`, key: `cloud-run-report:w-${i}`, updatedAt, metadata: {} };
}

describe('listRunReportArtifacts', () => {
  const cfg = { server: 'http://buildd.test/', apiKey: 'bld_admin', workspace: 'ws-1', since: '2026-09-01T00:00:00.000Z', until: '2026-09-02T00:00:00.000Z' };

  test('filters by key prefix, type and window, and pages with before=<oldest updatedAt>', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => artifact(i, `2026-09-01T12:${String(59 - i).padStart(2, '0')}:00.000Z`));
    const page2 = [artifact(50, '2026-09-01T11:00:00.000Z'), artifact(49, page1[49]!.updatedAt)]; // a repeat is dropped
    const { f, calls } = stubFetch((url) => {
      const before = new URL(url).searchParams.get('before');
      return Response.json({ artifacts: before === cfg.until ? page1 : page2 });
    });
    const out = await listRunReportArtifacts(f, cfg);
    expect(out).toHaveLength(51);
    expect(calls).toHaveLength(2);
    const q1 = new URL(calls[0]!.url);
    expect(q1.pathname).toBe('/api/workspaces/ws-1/artifacts');
    expect(q1.searchParams.get('keyPrefix')).toBe('cloud-run-report:');
    expect(q1.searchParams.get('type')).toBe('data');
    expect(q1.searchParams.get('limit')).toBe('50');
    expect(q1.searchParams.get('since')).toBe(cfg.since);
    expect(q1.searchParams.get('before')).toBe(cfg.until);
    expect(new URL(calls[1]!.url).searchParams.get('before')).toBe(page1[49]!.updatedAt);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer bld_admin');
  });

  test('a non-2xx is an error that names the route, never the key', async () => {
    const { f } = stubFetch(() => new Response('{"error":"Workspace not found"}', { status: 404 }));
    const err = await listRunReportArtifacts(f, cfg).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('404');
    expect(err.message).not.toContain('bld_admin');
  });
});

describe('fetchContainerAnalytics', () => {
  const cfg = { token: 'cf-token', accountId: 'acct', start: Date.parse('2026-09-01T10:00:00Z'), end: Date.parse('2026-09-01T11:00:00Z') };
  const metricsBody = { data: { viewer: { accounts: [{ containersMetricsAdaptiveGroups: [{ dimensions: { instanceId: 'i', datetimeMinute: '2026-09-01T10:00:00Z', run: 't.1' }, sum: { cpuTimeSec: 1, rxBytes: 2, txBytes: 3 }, max: { memory: 4 } }] }] } } };
  const usageBody = { data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: [{ dimensions: { instanceId: 'i', date: '2026-09-01', run: 't.1' }, sum: { cpuTimeSec: 1, allocatedMemory: 2, allocatedDisk: 3, txBytes: 4 } }] }] } } };

  test('posts both queries to the GraphQL endpoint with the account tag and window', async () => {
    const { f, calls } = stubFetch((_url, init) => {
      const { query } = JSON.parse(init!.body as string);
      return Response.json(query.includes('containersMetricsAdaptiveGroups') ? metricsBody : usageBody);
    });
    const r = await fetchContainerAnalytics(f, cfg);
    expect(r.metrics).toHaveLength(1);
    expect(r.usage).toHaveLength(1);
    expect(r.warnings).toEqual([]);
    expect(calls.map(c => c.url)).toEqual(['https://api.cloudflare.com/client/v4/graphql', 'https://api.cloudflare.com/client/v4/graphql']);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer cf-token');
    const v0 = JSON.parse(calls[0]!.init!.body as string).variables;
    expect(v0).toEqual({ accountTag: 'acct', start: '2026-09-01T10:00:00.000Z', end: '2026-09-01T11:00:00.000Z' });
    const v1 = JSON.parse(calls[1]!.init!.body as string).variables;
    expect(v1).toEqual({ accountTag: 'acct', startDate: '2026-09-01', endDate: '2026-09-01' });
  });

  test('a rejected label dimension falls back to a query without it, with a warning', async () => {
    const { f, calls } = stubFetch((_url, init) => {
      const { query } = JSON.parse(init!.body as string);
      if (query.includes('label(')) return Response.json({ data: null, errors: [{ message: 'unknown field "label"' }] });
      return Response.json(query.includes('containersMetricsAdaptiveGroups') ? metricsBody : usageBody);
    });
    const r = await fetchContainerAnalytics(f, cfg);
    expect(calls).toHaveLength(4);
    expect(r.metrics).toHaveLength(1);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('without the bd_run label');
  });

  test('a dataset that fails both ways is a warning, not a throw, and the token is not in it', async () => {
    const { f } = stubFetch(() => new Response('forbidden', { status: 403 }));
    const r = await fetchContainerAnalytics(f, cfg);
    expect(r.metrics).toEqual([]);
    expect(r.usage).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join(' ')).toContain('403');
    expect(r.warnings.join(' ')).not.toContain('cf-token');
  });
});
