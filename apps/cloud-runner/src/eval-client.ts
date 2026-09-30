/**
 * Network half of `scripts/eval-report.ts`. Small on purpose: every call takes
 * `fetch`, so eval-client.test.ts drives it with a stub. Tokens go in the
 * Authorization header only and never appear in an error message.
 */
import { RUN_REPORT_KEY_PREFIX } from './run-report';
import {
  GRAPHQL_URL,
  GraphqlError,
  isoDate,
  metricsQuery,
  parseMetricsResponse,
  parseUsageResponse,
  usageQuery,
  type MetricsGroup,
  type UsageGroup,
} from './eval-report';

type Fetch = typeof fetch;

const PAGE = 50; // the route's cap
const MAX_PAGES = 200;

/**
 * Every `cloud-run-report:*` data artifact in the workspace updated in
 * [since, until), newest first, paging with `before=<oldest updatedAt seen>`
 * (GET /api/workspaces/:id/artifacts).
 */
export async function listRunReportArtifacts(
  f: Fetch,
  cfg: { server: string; apiKey: string; workspace: string; since: string; until: string },
): Promise<Array<Record<string, unknown>>> {
  const base = `${cfg.server.replace(/\/+$/, '')}/api/workspaces/${encodeURIComponent(cfg.workspace)}/artifacts`;
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  let before = cfg.until;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ keyPrefix: `${RUN_REPORT_KEY_PREFIX}:`, type: 'data', limit: String(PAGE), since: cfg.since, before });
    const res = await f(`${base}?${qs}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`GET /api/workspaces/${cfg.workspace}/artifacts returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const body = (await res.json()) as { artifacts?: Array<Record<string, unknown>> };
    const batch = Array.isArray(body.artifacts) ? body.artifacts : [];
    for (const a of batch) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
    if (batch.length < PAGE) break;
    const oldest = batch[batch.length - 1]?.updatedAt;
    if (typeof oldest !== 'string' || oldest >= before) break;
    before = oldest;
  }
  return out;
}

async function graphql(f: Fetch, token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await f(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new GraphqlError(`Cloudflare GraphQL returned ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new GraphqlError('Cloudflare GraphQL returned a non-JSON body');
  }
}

export interface AnalyticsResult {
  metrics: MetricsGroup[];
  usage: UsageGroup[];
  warnings: string[];
}

/**
 * Both datasets over [start, end]. Each is tried with the `bd_run` label
 * dimension first and, if Cloudflare rejects that, without it. A dataset that
 * fails both ways becomes a warning, not a crash: the reports alone still make
 * a useful summary.
 */
export async function fetchContainerAnalytics(
  f: Fetch,
  cfg: { token: string; accountId: string; start: number; end: number },
): Promise<AnalyticsResult> {
  const warnings: string[] = [];
  const attempt = async <T>(name: string, run: (withLabel: boolean) => Promise<T[]>): Promise<T[]> => {
    try {
      return await run(true);
    } catch (first) {
      try {
        const rows = await run(false);
        warnings.push(`${name}: queried without the bd_run label (${(first as Error).message}); runs matched by instance ID and time`);
        return rows;
      } catch (second) {
        warnings.push(`${name}: ${(second as Error).message}`);
        return [];
      }
    }
  };
  const metrics = await attempt('containersMetricsAdaptiveGroups', async (withLabel) =>
    parseMetricsResponse(await graphql(f, cfg.token, metricsQuery(withLabel), {
      accountTag: cfg.accountId, start: new Date(cfg.start).toISOString(), end: new Date(cfg.end).toISOString(),
    })));
  const usage = await attempt('containersUsageAdaptiveGroups', async (withLabel) =>
    parseUsageResponse(await graphql(f, cfg.token, usageQuery(withLabel), {
      accountTag: cfg.accountId, startDate: isoDate(cfg.start), endDate: isoDate(cfg.end),
    })));
  if (metrics.length >= 10_000 || usage.length >= 10_000) warnings.push('an analytics query hit its 10000-group limit; narrow --since/--until');
  return { metrics, usage, warnings };
}
