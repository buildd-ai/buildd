#!/usr/bin/env bun
/**
 * Evaluate cloud runner runs over a time window: one CSV row per run plus a
 * markdown summary (phase p50/p90, outcomes, container resources, estimated
 * compute cost). See README "Measuring runs".
 *
 *   BUILDD_SERVER=https://buildd.dev BUILDD_API_KEY=bld_… \
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *   bun apps/cloud-runner/scripts/eval-report.ts --workspace <id> --since 2026-09-01T00:00:00Z [--until <iso>] [--out <dir>]
 *
 * Writes `<out>/cloud-runs.csv` and `<out>/cloud-runs.md` (default: the
 * current directory) and prints the summary. Without the Cloudflare variables
 * it still writes the report-only columns and says so.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fetchContainerAnalytics, listRunReportArtifacts } from '../src/eval-client';
import {
  analyticsWindow,
  joinRuns,
  parseEvalArgs,
  reportsFromArtifacts,
  reportsInWindow,
  summaryMarkdown,
  toCsv,
} from '../src/eval-report';

async function main(): Promise<number> {
  const args = parseEvalArgs(process.argv.slice(2), Date.now());
  if ('error' in args) {
    console.error(`${args.error}\nUsage: eval-report.ts --workspace <id> --since <iso> [--until <iso>] [--out <dir>]`);
    return 64;
  }
  const server = process.env.BUILDD_SERVER;
  const apiKey = process.env.BUILDD_API_KEY;
  if (!server || !apiKey) {
    console.error('BUILDD_SERVER and BUILDD_API_KEY are required');
    return 64;
  }

  const artifacts = await listRunReportArtifacts(fetch, { server, apiKey, workspace: args.workspace, since: args.since, until: args.until });
  const since = Date.parse(args.since);
  const until = Date.parse(args.until);
  const reports = reportsInWindow(reportsFromArtifacts(artifacts), since, until);
  console.error(`${artifacts.length} report artifact(s), ${reports.length} run(s) dispatched in the window`);

  const warnings: string[] = [];
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  let metrics: Parameters<typeof joinRuns>[1] = [];
  let usage: Parameters<typeof joinRuns>[2] = [];
  if (!token || !accountId) {
    warnings.push('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set: container metrics and cost left empty');
  } else if (reports.length > 0) {
    const w = analyticsWindow(reports, since, until);
    const a = await fetchContainerAnalytics(fetch, { token, accountId, start: w.start, end: w.end });
    metrics = a.metrics;
    usage = a.usage;
    warnings.push(...a.warnings);
  }

  const rows = joinRuns(reports, metrics, usage);
  const csv = toCsv(rows);
  const md = summaryMarkdown(rows, { workspace: args.workspace, since: args.since, until: args.until }, warnings);
  const dir = args.out ?? process.cwd();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cloud-runs.csv'), csv);
  writeFileSync(join(dir, 'cloud-runs.md'), md);
  console.log(md);
  console.error(`wrote ${join(dir, 'cloud-runs.csv')} and ${join(dir, 'cloud-runs.md')}`);
  return 0;
}

main().then(code => process.exit(code), (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
