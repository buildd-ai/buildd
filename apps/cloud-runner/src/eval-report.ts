/**
 * Pure half of `scripts/eval-report.ts`: turn `cloud-run-report` artifacts and
 * Cloudflare container analytics into one CSV row per run and a markdown
 * summary. No I/O here; the network client is eval-client.ts.
 *
 * GraphQL fields are the ones documented in
 * https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/
 *   containersMetricsAdaptiveGroups: what the workload used (no platform overhead).
 *     sum { cpuTimeSec rxBytes txBytes }, max { memory }, dimensions instanceId,
 *     label(name: "..."), datetimeMinute; filter datetime_geq / datetime_leq.
 *   containersUsageAdaptiveGroups: what is billed (container + sandbox VM).
 *     sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }; allocatedMemory
 *     and allocatedDisk are byte-seconds; filter date_geq / date_leq.
 * The metrics page does not state the unit of `memory`; it is reported as-is.
 */
import { RUN_LABEL_NAME, RUN_REPORT_KIND, type RunReport } from './run-report';

// ── Prices ────────────────────────────────────────────────────────────────────
// List prices, Workers Paid, beyond the included allowance:
// https://developers.cloudflare.com/containers/pricing/
export const PRICE_MEMORY_PER_GIB_SECOND = 0.0000025;
export const PRICE_VCPU_PER_SECOND = 0.000020;
export const PRICE_DISK_PER_GB_SECOND = 0.00000007;

const GIB = 1024 ** 3;
const GB = 1e9;

export interface UsageTotals {
  cpuTimeSec: number;
  /** byte-seconds */
  allocatedMemory: number;
  /** byte-seconds */
  allocatedDisk: number;
  txBytes: number;
}

export interface CostEstimate {
  memoryUsd: number;
  vcpuUsd: number;
  diskUsd: number;
  totalUsd: number;
}

/** Compute cost at list prices, ignoring the monthly included allowance. */
export function estimateCost(u: UsageTotals): CostEstimate {
  const memoryUsd = (u.allocatedMemory / GIB) * PRICE_MEMORY_PER_GIB_SECOND;
  const vcpuUsd = u.cpuTimeSec * PRICE_VCPU_PER_SECOND;
  const diskUsd = (u.allocatedDisk / GB) * PRICE_DISK_PER_GB_SECOND;
  return { memoryUsd, vcpuUsd, diskUsd, totalUsd: memoryUsd + vcpuUsd + diskUsd };
}

// ── Percentiles ───────────────────────────────────────────────────────────────

/** Linear interpolation between closest ranks (the common "R-7" definition). Null for no data. */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0]!;
  const rank = (Math.min(Math.max(p, 0), 100) / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (rank - lo);
}

// ── Reports from artifacts ────────────────────────────────────────────────────

interface ArtifactLike {
  key?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
}

function looksLikeReport(v: unknown): v is RunReport {
  const r = v as Partial<RunReport> | null;
  return !!r && r.kind === RUN_REPORT_KIND && typeof r.attempt === 'number' && !!r.timestamps && !!r.egress;
}

/**
 * The report from each artifact: `metadata.report` (kept for every workspace),
 * else the JSON in `content`. Anything else is skipped. One per worker.
 */
export function reportsFromArtifacts(artifacts: readonly ArtifactLike[]): RunReport[] {
  const out = new Map<string, RunReport>();
  for (const a of artifacts) {
    let report: unknown = a.metadata?.report;
    if (!looksLikeReport(report) && typeof a.content === 'string') {
      try { report = JSON.parse(a.content); } catch { report = null; }
    }
    if (!looksLikeReport(report)) continue;
    const id = report.workerId ?? report.runLabel ?? a.key ?? String(out.size);
    out.set(id, report);
  }
  return [...out.values()];
}

/** Reports whose dispatch falls inside [since, until). */
export function reportsInWindow(reports: readonly RunReport[], since: number, until: number): RunReport[] {
  return reports.filter(r => {
    const t = r.timestamps.dispatchReceivedAt ?? r.timestamps.exitedAt;
    return t !== null && t >= since && t < until;
  });
}

// ── GraphQL ───────────────────────────────────────────────────────────────────

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
export const GRAPHQL_LIMIT = 10_000;

/**
 * Per instance, per `bd_run` label, per minute. Minute groups give the peak
 * (max of the per-minute max) and an average of the per-minute peaks.
 * `withLabel: false` drops the label dimension, for accounts or datasets that
 * refuse it; runs are then matched by instance ID and time window.
 */
export function metricsQuery(withLabel: boolean): string {
  return `query CloudRunMetrics($accountTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      containersMetricsAdaptiveGroups(
        limit: ${GRAPHQL_LIMIT}
        filter: { datetime_geq: $start, datetime_leq: $end }
        orderBy: [datetimeMinute_ASC]
      ) {
        dimensions {
          instanceId
          datetimeMinute${withLabel ? `\n          run: label(name: "${RUN_LABEL_NAME}")` : ''}
        }
        sum { cpuTimeSec rxBytes txBytes }
        max { memory }
      }
    }
  }
}`;
}

export function usageQuery(withLabel: boolean): string {
  return `query CloudRunUsage($accountTag: String!, $startDate: Date!, $endDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      containersUsageAdaptiveGroups(
        limit: ${GRAPHQL_LIMIT}
        filter: { date_geq: $startDate, date_leq: $endDate }
      ) {
        dimensions {
          instanceId
          date${withLabel ? `\n          run: label(name: "${RUN_LABEL_NAME}")` : ''}
        }
        sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
      }
    }
  }
}`;
}

export interface MetricsGroup {
  instanceId: string | null;
  run: string | null;
  minute: number | null;
  cpuTimeSec: number;
  rxBytes: number;
  txBytes: number;
  memoryMax: number | null;
}

export interface UsageGroup extends UsageTotals {
  instanceId: string | null;
  run: string | null;
  date: string | null;
}

export class GraphqlError extends Error {}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function groupsOf(json: unknown, dataset: string): Array<Record<string, any>> {
  const j = json as { errors?: Array<{ message?: string }>; data?: any } | null;
  if (j?.errors?.length) throw new GraphqlError(j.errors.map(e => e.message ?? 'unknown error').join('; '));
  const accounts = j?.data?.viewer?.accounts;
  if (!Array.isArray(accounts)) throw new GraphqlError('unexpected response: no viewer.accounts');
  return accounts.flatMap((a: any) => (Array.isArray(a?.[dataset]) ? a[dataset] : []));
}

export function parseMetricsResponse(json: unknown): MetricsGroup[] {
  return groupsOf(json, 'containersMetricsAdaptiveGroups').map(g => {
    const minute = str(g.dimensions?.datetimeMinute);
    const ms = minute ? Date.parse(minute) : NaN;
    return {
      instanceId: str(g.dimensions?.instanceId),
      run: str(g.dimensions?.run),
      minute: Number.isFinite(ms) ? ms : null,
      cpuTimeSec: num(g.sum?.cpuTimeSec),
      rxBytes: num(g.sum?.rxBytes),
      txBytes: num(g.sum?.txBytes),
      memoryMax: typeof g.max?.memory === 'number' ? g.max.memory : null,
    };
  });
}

export function parseUsageResponse(json: unknown): UsageGroup[] {
  return groupsOf(json, 'containersUsageAdaptiveGroups').map(g => ({
    instanceId: str(g.dimensions?.instanceId),
    run: str(g.dimensions?.run),
    date: str(g.dimensions?.date),
    cpuTimeSec: num(g.sum?.cpuTimeSec),
    allocatedMemory: num(g.sum?.allocatedMemory),
    allocatedDisk: num(g.sum?.allocatedDisk),
    txBytes: num(g.sum?.txBytes),
  }));
}

// ── Join ──────────────────────────────────────────────────────────────────────

export interface RunMetrics {
  vcpuSecondsActive: number;
  memoryPeak: number | null;
  memoryAvg: number | null;
  rxBytes: number;
  txBytes: number;
  minutes: number;
}

export interface EvalRow {
  report: RunReport;
  metrics: RunMetrics | null;
  usage: UsageTotals | null;
  cost: CostEstimate | null;
  /** How metrics/usage were matched: by the bd_run label, by instance + time, or not at all. */
  match: 'label' | 'instance_window' | 'none';
}

const SLACK_MS = 60_000;

function inWindow(r: RunReport, at: number | null): boolean {
  const from = r.timestamps.dispatchReceivedAt;
  const to = r.timestamps.exitedAt ?? from;
  if (at === null || from === null || to === null) return false;
  return at >= Math.floor(from / 60_000) * 60_000 - SLACK_MS && at <= to + SLACK_MS;
}

function sumMetrics(groups: readonly MetricsGroup[]): RunMetrics | null {
  if (groups.length === 0) return null;
  const peaks = groups.map(g => g.memoryMax).filter((m): m is number => m !== null);
  return {
    vcpuSecondsActive: groups.reduce((s, g) => s + g.cpuTimeSec, 0),
    memoryPeak: peaks.length ? Math.max(...peaks) : null,
    memoryAvg: peaks.length ? peaks.reduce((s, m) => s + m, 0) / peaks.length : null,
    rxBytes: groups.reduce((s, g) => s + g.rxBytes, 0),
    txBytes: groups.reduce((s, g) => s + g.txBytes, 0),
    minutes: new Set(groups.map(g => g.minute)).size,
  };
}

function sumUsage(groups: readonly UsageGroup[]): UsageTotals | null {
  if (groups.length === 0) return null;
  return groups.reduce<UsageTotals>((s, g) => ({
    cpuTimeSec: s.cpuTimeSec + g.cpuTimeSec,
    allocatedMemory: s.allocatedMemory + g.allocatedMemory,
    allocatedDisk: s.allocatedDisk + g.allocatedDisk,
    txBytes: s.txBytes + g.txBytes,
  }), { cpuTimeSec: 0, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0 });
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Match analytics to runs. By the `bd_run` label when present (exact). Else by
 * instance ID: metrics minutes inside the run's window; usage only when no
 * other run of the same instance falls on the same days, because usage is
 * per day and a shared day cannot be split.
 */
export function joinRuns(reports: readonly RunReport[], metrics: readonly MetricsGroup[], usage: readonly UsageGroup[]): EvalRow[] {
  return reports.map(report => {
    const label = report.runLabel;
    let m = label ? metrics.filter(g => g.run === label) : [];
    let u = label ? usage.filter(g => g.run === label) : [];
    let match: EvalRow['match'] = m.length || u.length ? 'label' : 'none';
    if (match === 'none' && report.containerInstanceId) {
      const inst = report.containerInstanceId;
      m = metrics.filter(g => g.run === null && g.instanceId === inst && inWindow(report, g.minute));
      const days = runDays(report);
      const shared = reports.some(o => o !== report && o.containerInstanceId === inst && runDays(o).some(d => days.includes(d)));
      u = shared ? [] : usage.filter(g => g.run === null && g.instanceId === inst && g.date !== null && days.includes(g.date));
      if (m.length || u.length) match = 'instance_window';
    }
    const usageTotals = sumUsage(u);
    return { report, metrics: sumMetrics(m), usage: usageTotals, cost: usageTotals ? estimateCost(usageTotals) : null, match };
  });
}

function runDays(r: RunReport): string[] {
  const from = r.timestamps.dispatchReceivedAt;
  const to = r.timestamps.exitedAt ?? from;
  if (from === null || to === null) return [];
  const days: string[] = [];
  for (let t = Date.parse(isoDate(from)); t <= to; t += 86_400_000) days.push(isoDate(t));
  return days;
}

// ── Output ────────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  'task_id', 'attempt', 'worker_id', 'instance_id', 'run_label', 'instance_type', 'outcome', 'exit_code', 'crash_report',
  'dispatch_received_at', 'container_running_at', 'claimed_at', 'first_model_request_at', 'exited_at',
  'container_start_ms', 'to_claim_ms', 'clone_ms', 'install_ms', 'to_first_model_request_ms', 'total_ms',
  'model_requests', 'model_response_bytes', 'github_requests', 'github_response_bytes', 'passthrough_requests', 'passthrough_response_bytes',
  'match', 'vcpu_seconds_active', 'memory_peak', 'memory_avg', 'rx_bytes', 'tx_bytes',
  'billed_cpu_seconds', 'billed_memory_byte_seconds', 'billed_disk_byte_seconds', 'est_cost_usd',
] as const;

function iso(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString();
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowValues(row: EvalRow): Record<typeof CSV_COLUMNS[number], unknown> {
  const r = row.report;
  const t = r.timestamps;
  const d = r.durationsMs;
  return {
    task_id: r.taskId, attempt: r.attempt, worker_id: r.workerId, instance_id: r.containerInstanceId, run_label: r.runLabel,
    instance_type: r.instanceType, outcome: r.outcome, exit_code: r.exitCode, crash_report: r.crashReport,
    dispatch_received_at: iso(t.dispatchReceivedAt), container_running_at: iso(t.containerRunningAt), claimed_at: iso(t.claimedAt),
    first_model_request_at: iso(t.firstModelRequestAt), exited_at: iso(t.exitedAt),
    container_start_ms: d.containerStart, to_claim_ms: d.toClaim, clone_ms: d.clone, install_ms: d.install,
    to_first_model_request_ms: d.toFirstModelRequest, total_ms: d.total,
    model_requests: r.egress.model.requests, model_response_bytes: r.egress.model.responseBytes,
    github_requests: r.egress.github.requests, github_response_bytes: r.egress.github.responseBytes,
    passthrough_requests: r.egress.passthrough.requests, passthrough_response_bytes: r.egress.passthrough.responseBytes,
    match: row.match,
    vcpu_seconds_active: row.metrics?.vcpuSecondsActive, memory_peak: row.metrics?.memoryPeak, memory_avg: row.metrics?.memoryAvg,
    rx_bytes: row.metrics?.rxBytes, tx_bytes: row.metrics?.txBytes,
    billed_cpu_seconds: row.usage?.cpuTimeSec, billed_memory_byte_seconds: row.usage?.allocatedMemory,
    billed_disk_byte_seconds: row.usage?.allocatedDisk, est_cost_usd: row.cost ? row.cost.totalUsd.toFixed(6) : null,
  };
}

export function toCsv(rows: readonly EvalRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    const v = rowValues(row);
    lines.push(CSV_COLUMNS.map(c => cell(v[c])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export const PHASES: ReadonlyArray<[keyof RunReport['durationsMs'], string]> = [
  ['containerStart', 'dispatch to container running'],
  ['toClaim', 'container running to claim'],
  ['clone', 'clone'],
  ['install', 'dependency install'],
  ['toFirstModelRequest', 'claim to first model request'],
  ['total', 'dispatch to exit'],
];

/** `outcome (exit N)`, plus the crash report for crashes. */
export function causeOf(r: RunReport): string {
  const base = `${r.outcome ?? 'unknown'} (exit ${r.exitCode ?? 'none'})`;
  return r.outcome === 'crashed' && r.crashReport ? `${base}, crash report ${r.crashReport}` : base;
}

function fmtMs(v: number | null): string {
  return v === null ? 'n/a' : `${(v / 1000).toFixed(1)} s`;
}
function fmtNum(v: number | null, digits = 1): string {
  return v === null ? 'n/a' : v.toFixed(digits);
}
function stats(values: number[]): { p50: number | null; p90: number | null; n: number } {
  return { p50: percentile(values, 50), p90: percentile(values, 90), n: values.length };
}

export function summaryMarkdown(rows: readonly EvalRow[], window: { since: string; until: string; workspace: string }, warnings: readonly string[] = []): string {
  const out: string[] = [];
  out.push(`# Cloud runner eval: ${rows.length} run(s)`);
  out.push('');
  out.push(`Workspace \`${window.workspace}\`, ${window.since} to ${window.until}.`);
  out.push('');
  out.push('## Phases');
  out.push('');
  out.push('| Phase | n | p50 | p90 |');
  out.push('|---|---|---|---|');
  for (const [key, label] of PHASES) {
    const s = stats(rows.map(r => r.report.durationsMs[key]).filter((v): v is number => v !== null));
    out.push(`| ${label} | ${s.n} | ${fmtMs(s.p50)} | ${fmtMs(s.p90)} |`);
  }
  out.push('');
  out.push('## Outcomes');
  out.push('');
  out.push('| Cause | Runs |');
  out.push('|---|---|');
  const causes = new Map<string, number>();
  for (const r of rows) causes.set(causeOf(r.report), (causes.get(causeOf(r.report)) ?? 0) + 1);
  for (const [cause, n] of [...causes].sort((a, b) => b[1] - a[1])) out.push(`| ${cause} | ${n} |`);
  out.push('');
  out.push('## Container resources');
  out.push('');
  const withMetrics = rows.filter(r => r.metrics);
  const withCost = rows.filter(r => r.cost);
  out.push(`Matched to analytics: ${withMetrics.length} of ${rows.length} run(s) (metrics), ${withCost.length} (billing usage).`);
  out.push('');
  out.push('| Per run | p50 | p90 | Total |');
  out.push('|---|---|---|---|');
  const metric = (label: string, pick: (r: EvalRow) => number | null | undefined, digits = 1) => {
    const vs = rows.map(pick).filter((v): v is number => typeof v === 'number');
    const s = stats(vs);
    out.push(`| ${label} | ${fmtNum(s.p50, digits)} | ${fmtNum(s.p90, digits)} | ${vs.length ? fmtNum(vs.reduce((a, b) => a + b, 0), digits) : 'n/a'} |`);
  };
  metric('active vCPU-seconds', r => r.metrics?.vcpuSecondsActive);
  metric('peak memory (as reported)', r => r.metrics?.memoryPeak, 0);
  metric('avg of per-minute peak memory', r => r.metrics?.memoryAvg, 0);
  metric('rx bytes', r => r.metrics?.rxBytes, 0);
  metric('tx bytes', r => r.metrics?.txBytes, 0);
  metric('est. compute cost, USD', r => r.cost?.totalUsd, 6);
  out.push('');
  out.push(`Cost at list prices (memory $${PRICE_MEMORY_PER_GIB_SECOND}/GiB-s, vCPU $${PRICE_VCPU_PER_SECOND}/vCPU-s, disk $${PRICE_DISK_PER_GB_SECOND}/GB-s; https://developers.cloudflare.com/containers/pricing/), from billed usage, before the included allowance. Workers and Durable Object requests are not included.`);
  out.push('');
  out.push('## Egress (from the run reports)');
  out.push('');
  out.push('| Class | Requests (total) | Response bytes (total) |');
  out.push('|---|---|---|');
  for (const cls of ['model', 'github', 'passthrough'] as const) {
    const req = rows.reduce((s, r) => s + r.report.egress[cls].requests, 0);
    const bytes = rows.reduce((s, r) => s + r.report.egress[cls].responseBytes, 0);
    out.push(`| ${cls} | ${req} | ${bytes} |`);
  }
  if (warnings.length) {
    out.push('');
    out.push('## Warnings');
    out.push('');
    for (const w of warnings) out.push(`- ${w}`);
  }
  out.push('');
  return out.join('\n');
}

// ── Args ──────────────────────────────────────────────────────────────────────

export interface EvalArgs {
  workspace: string;
  since: string;
  until: string;
  out: string | null;
}

export function parseEvalArgs(argv: readonly string[], now: number): EvalArgs | { error: string } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find(a => a.startsWith(`${flag}=`));
    return eq?.slice(flag.length + 1);
  };
  const workspace = get('--workspace');
  const since = get('--since');
  const until = get('--until') ?? new Date(now).toISOString();
  if (!workspace || workspace.startsWith('--')) return { error: '--workspace <id> is required' };
  if (!since || Number.isNaN(Date.parse(since))) return { error: '--since <iso timestamp> is required' };
  if (Number.isNaN(Date.parse(until))) return { error: '--until must be an ISO timestamp' };
  if (Date.parse(until) <= Date.parse(since)) return { error: '--until must be after --since' };
  const out = get('--out') ?? null;
  return { workspace, since: new Date(since).toISOString(), until: new Date(until).toISOString(), out };
}

/** The analytics window: from the first dispatch to the last exit, two minutes of slack each side. */
export function analyticsWindow(reports: readonly RunReport[], since: number, until: number): { start: number; end: number } {
  const froms = reports.map(r => r.timestamps.dispatchReceivedAt).filter((v): v is number => v !== null);
  const tos = reports.map(r => r.timestamps.exitedAt ?? r.timestamps.dispatchReceivedAt).filter((v): v is number => v !== null);
  if (!froms.length || !tos.length) return { start: since, end: until };
  return { start: Math.min(...froms) - SLACK_MS * 2, end: Math.max(...tos) + SLACK_MS * 2 };
}

export { isoDate };
