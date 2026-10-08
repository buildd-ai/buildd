/**
 * The Dispatch health report: one shape, one verdict, two surfaces (the
 * `dispatch_health` MCP action and the /app/health Dispatch section). Pure:
 * no DB, no network, safe to import from a client component. The reads live
 * in apps/web/src/lib/dispatch-health.ts.
 *
 * Postgres first. Receipts project the Worker's outcomes onto the outbox
 * rows, so every count here comes from `task_dispatch_outbox`; the only
 * Worker call is its unsigned `/health` reachability probe.
 */

export type DispatchTransportMode = 'in_app' | 'shadow' | 'dispatch';

/** One team's (or one workspace's) outbox, as dispatchTeamHealthSql counts it. */
export interface DispatchTeamHealth {
  pending: number;
  /** Pending and due now, not yet delivered. */
  due: number;
  /** Pending and due over 5 minutes ago: a kick and the timer both missed it. */
  overdue: number;
  delivering: number;
  /** Delivering for over 5 minutes past its last attempt. */
  stuck: number;
  handedOff: number;
  /** Work rows of a `dispatch` workspace the Worker has not acked for over a minute. */
  unacked: number;
  /** Unacked past the in-app fallback (created and due over 5 min ago, never taken back). */
  unackedStale: number;
  /** Handed off, due over an hour ago, and still no terminal receipt. */
  orphaned: number;
  failed24h: number;
  delivered24h: number;
  /** Delivered rows in the last 24 h, by `delivered_via`. */
  deliveredVia: Record<string, number>;
  /** `delivered_at - not_before` over real deliveries in 24 h (merged and expired excluded). */
  latencyMs: { p50: number | null; p95: number | null; samples: number };
}

export function emptyTeamHealth(): DispatchTeamHealth {
  return {
    pending: 0, due: 0, overdue: 0, delivering: 0, stuck: 0, handedOff: 0, unacked: 0, unackedStale: 0,
    orphaned: 0, failed24h: 0, delivered24h: 0, deliveredVia: {}, latencyMs: { p50: null, p95: null, samples: 0 },
  };
}

export interface DispatchWorkerStatus {
  /** `unconfigured`: no DISPATCH_URL / signing key here, so nothing is published. */
  status: 'reachable' | 'unreachable' | 'unconfigured';
  /** The Worker's own `configured` flag from `/health`. */
  workerConfigured?: boolean;
  error?: string;
  ms?: number;
}

/** The reconcile counts of a floor run (lib/dispatch-reconcile.ts ReconcileCounts). */
export interface DispatchReconcileCounts {
  checked: number;
  republished: number;
  projected: number;
  fellBack: number;
  left: number;
  workerErrors: number;
}

/** The latest `dispatch-drain` floor run from `cron_runs`. Platform-wide: the floor is not per team. */
export interface DispatchRepairRun {
  at: string;
  ok: boolean;
  reconcile: DispatchReconcileCounts | null;
  reconcileError: string | null;
}

export interface DispatchHealthInput {
  outbox: DispatchTeamHealth;
  workspaces: Array<{ id: string; name: string; transport: DispatchTransportMode }>;
  worker: DispatchWorkerStatus;
  /** null: no floor run is recorded. */
  lastRepair: DispatchRepairRun | null;
}

export interface DispatchHealthReport extends DispatchHealthInput {
  generatedAt: string;
  healthy: boolean;
  verdict: string;
  problems: string[];
}

/** The floor is hourly; past this it has missed a run. */
export const FLOOR_STALE_MS = 2 * 3600_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'n/a';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.floor(ms / 3600_000)}h`;
}

/** Repairs the floor made that it should not have had to. */
export function repairedCount(rc: DispatchReconcileCounts | null): number {
  return rc ? rc.republished + rc.projected + rc.fellBack : 0;
}

export function dispatchVerdict(input: DispatchHealthInput, nowMs: number): Pick<DispatchHealthReport, 'healthy' | 'verdict' | 'problems'> {
  const { outbox: o, workspaces, worker, lastRepair } = input;
  const problems: string[] = [];
  const onDispatch = workspaces.filter(w => w.transport === 'dispatch').length;
  const usesWorker = workspaces.some(w => w.transport !== 'in_app');

  if (worker.status === 'unconfigured') {
    if (onDispatch > 0) problems.push(`Dispatch transport not configured: ${plural(onDispatch, 'workspace')} on dispatch deliver in-app only`);
  } else if (worker.status === 'unreachable') {
    if (usesWorker) problems.push(`Dispatch Worker unreachable${worker.error ? ` (${worker.error})` : ''}`);
  } else if (worker.workerConfigured === false && usesWorker) {
    problems.push('Dispatch Worker reachable but reports itself unconfigured');
  }

  if (o.failed24h > 0) problems.push(`${plural(o.failed24h, 'wake')} failed in 24h`);
  if (o.orphaned > 0) problems.push(`${plural(o.orphaned, 'handed-off wake')} over an hour past due with no receipt`);
  if (o.unackedStale > 0) problems.push(`${plural(o.unackedStale, 'unacked wake')} the in-app fallback did not take`);
  if (o.overdue > 0) problems.push(`${plural(o.overdue, 'wake')} due over 5 min and undelivered`);
  if (o.stuck > 0) problems.push(`${plural(o.stuck, 'wake')} delivering for over 5 min`);

  if (lastRepair) {
    const age = nowMs - Date.parse(lastRepair.at);
    if (Number.isFinite(age) && age > FLOOR_STALE_MS) {
      problems.push(`Floor has not run for ${formatDuration(age)} (last ${lastRepair.at})`);
    }
    if (!lastRepair.ok) problems.push('Last floor run failed');
    if (lastRepair.reconcileError) problems.push(`Last floor run: reconcile failed (${lastRepair.reconcileError})`);
    const repaired = repairedCount(lastRepair.reconcile);
    if (repaired > 0) problems.push(`Last floor run had to repair ${plural(repaired, 'row')} (platform-wide)`);
    const workerErrors = lastRepair.reconcile?.workerErrors ?? 0;
    if (workerErrors > 0) problems.push(`Last floor run had ${plural(workerErrors, 'Worker error')} (platform-wide)`);
  }

  if (problems.length === 0) {
    const verdict = o.delivered24h > 0
      ? `Healthy: ${plural(o.delivered24h, 'wake')} delivered in 24h, p95 ${formatDuration(o.latencyMs.p95)}.`
      : 'Healthy: no wakes delivered in 24h.';
    return { healthy: true, verdict, problems };
  }
  const verdict = problems.length === 1
    ? problems[0]
    : `${problems.length} issues: ${problems.slice(0, 2).join('; ')}${problems.length > 2 ? `; +${problems.length - 2} more` : ''}`;
  return { healthy: false, verdict, problems };
}

/** The terse text the MCP action returns. Verdict first. */
export function formatDispatchHealth(r: DispatchHealthReport): string {
  const o = r.outbox;
  const lines = [`Dispatch: ${r.verdict}`];
  if (!r.healthy && r.problems.length > 1) lines.push('Problems:', ...r.problems.map(p => `- ${p}`));
  lines.push(
    `Outbox (${plural(r.workspaces.length, 'workspace')}): pending ${o.pending} (due ${o.due}, overdue ${o.overdue}) · delivering ${o.delivering} (stuck ${o.stuck}) · handed off ${o.handedOff} · unacked ${o.unacked} (stale ${o.unackedStale}) · orphaned ${o.orphaned} · failed 24h ${o.failed24h}`,
  );
  const via = Object.entries(o.deliveredVia).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
  const latency = o.latencyMs.samples > 0
    ? ` · latency p50 ${formatDuration(o.latencyMs.p50)}, p95 ${formatDuration(o.latencyMs.p95)} (n=${o.latencyMs.samples})`
    : '';
  lines.push(`Delivered 24h: ${o.delivered24h}${via ? ` (${via})` : ''}${latency}`);

  const w = r.worker;
  lines.push(`Worker: ${w.status === 'reachable'
    ? `reachable${w.ms !== undefined ? ` (${w.ms} ms)` : ''}${w.workerConfigured === false ? ', reports unconfigured' : ''}`
    : w.status === 'unreachable' ? `unreachable${w.error ? ` (${w.error})` : ''}` : 'not configured here'}`);

  const f = r.lastRepair;
  if (!f) lines.push('Last floor run: none recorded');
  else {
    const rc = f.reconcile;
    const counts = rc
      ? `checked ${rc.checked}, republished ${rc.republished}, projected ${rc.projected}, fellBack ${rc.fellBack}, left ${rc.left}, workerErrors ${rc.workerErrors}`
      : f.reconcileError ? `reconcile failed: ${f.reconcileError}` : 'no reconcile counts stored';
    lines.push(`Last floor run (platform-wide): ${f.at}, ${f.ok ? 'ok' : 'failed'} · ${counts}`);
  }

  const off = r.workspaces.filter(x => x.transport !== 'dispatch');
  if (off.length > 0) lines.push(`Not on dispatch (kill switch): ${off.map(x => `${x.name} (${x.transport})`).join(', ')}`);
  return lines.join('\n');
}
