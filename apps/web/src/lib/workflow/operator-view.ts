/**
 * The kernel section of the platform-operator Health page: what the durable
 * log says the workflow kernel did (docs/specs/workflow-kernel-library.md §3).
 *
 * Read-only and bounded. Every statement is a SELECT with a LIMIT or an
 * aggregate over a window, and each reaches its rows through an index:
 *  - transitions and the host=web count by `workflow_transitions_created_idx`,
 *  - a delivery's own history by its `(delivery_id, to_version)` index,
 *  - a PR by `(workspace_id, repo_full_name, pr_number)`,
 *  - the parked commands by the partial `status = 'pending'` index and
 *    `workflow_command_outbox_created_idx`,
 *  - floor runs by `cron_runs_job_started_idx`.
 * A workspace or team scope is resolved to workspace ids first, so no query
 * filters on a cast of a key column.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { describeFinding } from '@buildd/workflow-kernel/findings';
import { landingStatusOf, LANDING_STATUS_CONTEXT } from '@buildd/workflow-kernel/landing-gate';
import { loadView, type Exec } from './kernel';
import { liveDeadEffects, type LiveDeadEffects } from './dead-effect-sweep';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

type J = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { KERNEL_WINDOWS, type KernelWindow } from '@/lib/kernel-windows';
export { KERNEL_WINDOWS, KERNEL_WINDOW_LABEL, TRANSITION_LIMIT, type KernelWindow } from '@/lib/kernel-windows';

import { TRANSITION_LIMIT } from '@/lib/kernel-windows';
export const WEB_RECENT_LIMIT = 5;
export const FLOOR_RUN_LIMIT = 8;
const TIMELINE_LIMIT = 200;
const TIMELINE_DELIVERIES = 3;

export interface KernelQuery {
  window: KernelWindow;
  /** A workspace id or exact name. */
  workspace?: string;
  /** A team id or slug. */
  team?: string;
  /** An exact command name, as the transition log records it. */
  command?: string;
  /** A PR number; the timeline needs a workspace as well. */
  pr?: number;
  now?: number;
}

export interface TransitionRow {
  id: string;
  command: string;
  fromState: string | null;
  toState: string;
  actor: string;
  host: string | null;
  at: string;
  prNumber: number | null;
  repo: string | null;
  workspaceId: string;
  workspaceName: string;
}

export interface ParkedOp { op: string; count: number; oldestAt: string; failing: number; lastError: string | null }
export interface ParkedView {
  total: number;
  oldestAt: string | null;
  byOp: ParkedOp[];
  /** Commands given up on inside the window. */
  gaveUp: number;
}

export interface FloorRun {
  id: string;
  startedAt: string;
  durationMs: number | null;
  ok: boolean;
  host: string;
  repaired: string[];
  problems: string[];
}

export interface TimelineStep {
  version: number;
  command: string;
  fromState: string | null;
  toState: string;
  actor: string;
  host: string | null;
  at: string;
  evidence: string;
  bypassed: boolean;
}

export interface PrTimeline {
  deliveryId: string;
  repo: string | null;
  prNumber: number;
  state: string;
  stateReason: string | null;
  workspaceName: string;
  steps: TimelineStep[];
  stepsOmitted: number;
  openFindings: string[];
  /** The `Buildd / Review approval` check as the kernel would publish it now; null when the delivery is over. */
  approval: { state: 'success' | 'failure' | 'pending'; description: string } | null;
  approvalContext: string;
}

export type TimelineResult =
  | { kind: 'idle' }
  | { kind: 'needs_workspace' }
  | { kind: 'no_workspace'; scope: string }
  | { kind: 'not_found'; prNumber: number }
  | { kind: 'found'; timelines: PrTimeline[] };

export interface KernelOperatorView {
  query: KernelQuery;
  since: string;
  now: number;
  /** Set when a workspace or team scope matched nothing: the transitions list is then empty on purpose. */
  scopeMissing: string | null;
  transitions: TransitionRow[];
  web: { count: number; recent: TransitionRow[] };
  parked: ParkedView;
  floorRuns: FloorRun[];
  /** Effects that are `dead` on a delivery still live: the floor leaves them for an operator. */
  deadEffects: LiveDeadEffects;
  timeline: TimelineResult;
}

type Param = string | string[] | undefined;
const first = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : v)?.trim().slice(0, 120) || undefined;

/** The page's `k`-prefixed search params as a query. Unknown values fall back; nothing here throws. */
export function parseKernelQuery(p: { kwindow?: Param; kworkspace?: Param; kteam?: Param; kcommand?: Param; kpr?: Param }, now?: number): KernelQuery {
  const w = first(p.kwindow);
  const pr = Number(first(p.kpr));
  return {
    window: w && w in KERNEL_WINDOWS ? (w as KernelWindow) : '24h',
    workspace: first(p.kworkspace), team: first(p.kteam), command: first(p.kcommand),
    pr: Number.isInteger(pr) && pr > 0 && pr < 2 ** 31 ? pr : undefined,
    now,
  };
}

const iso = (v: unknown): string => (v == null ? '' : new Date(String(v)).toISOString());
const str = (v: unknown): string | null => (v == null ? null : String(v));
const rows = (r: { rows?: unknown[] }): J[] => (r.rows ?? []) as J[];

function toTransition(r: J): TransitionRow {
  return {
    id: String(r.id), command: String(r.command), fromState: str(r.from_state), toState: String(r.to_state),
    actor: String(r.actor), host: str(r.host), at: iso(r.created_at),
    prNumber: r.pr_number == null ? null : Number(r.pr_number), repo: str(r.repo_full_name),
    workspaceId: String(r.workspace_id), workspaceName: String(r.workspace_name ?? ''),
  };
}

/** Workspace ids a scope names. Null scope: no filter. An empty list: the scope matched nothing. */
export async function resolveScope(q: Pick<KernelQuery, 'workspace' | 'team'>, exec: Exec = dbExec): Promise<{ ids: string[] | null; missing: string | null }> {
  const workspace = q.workspace?.trim();
  const team = q.team?.trim();
  if (!workspace && !team) return { ids: null, missing: null };
  const where: SQL[] = [];
  if (workspace) where.push(UUID.test(workspace) ? sql`w.id = ${workspace}::uuid` : sql`w.name = ${workspace}`);
  if (team) where.push(UUID.test(team) ? sql`w.team_id = ${team}::uuid` : sql`w.team_id = (SELECT t.id FROM teams t WHERE t.slug = ${team})`);
  const res = await exec(sql`SELECT w.id FROM workspaces w WHERE ${sql.join(where, sql` AND `)} LIMIT 200`);
  const ids = rows(res).map((r) => String(r.id));
  return { ids, missing: ids.length === 0 ? (workspace ? `workspace "${workspace}"` : `team "${team}"`) : null };
}

const idList = (ids: string[]) => sql`(SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) x)`;

const TRANSITION_COLUMNS = sql`tr.id, tr.command, tr.from_state, tr.to_state, tr.actor, tr.host, tr.created_at,
  d.pr_number, d.repo_full_name, d.workspace_id, w.name AS workspace_name`;

export async function recentTransitions(o: { since: string; ids: string[] | null; command?: string; host?: 'web'; limit: number }, exec: Exec = dbExec): Promise<TransitionRow[]> {
  const where: SQL[] = [sql`tr.created_at >= ${o.since}::timestamptz`];
  if (o.ids) where.push(sql`d.workspace_id IN ${idList(o.ids)}`);
  if (o.command) where.push(sql`tr.command = ${o.command}`);
  if (o.host) where.push(sql`tr.host = ${o.host}`);
  const res = await exec(sql`-- kernel_operator:transitions
SELECT ${TRANSITION_COLUMNS}
FROM workflow_transitions tr
JOIN workflow_deliveries d ON d.id = tr.delivery_id
JOIN workspaces w ON w.id = d.workspace_id
WHERE ${sql.join(where, sql` AND `)}
ORDER BY tr.created_at DESC
LIMIT ${o.limit}`);
  return rows(res).map(toTransition);
}

/** Transitions written by the web host in the window, platform-wide. The count should be zero. */
export async function webHostTransitions(since: string, exec: Exec = dbExec): Promise<{ count: number; recent: TransitionRow[] }> {
  const res = await exec(sql`-- kernel_operator:web_count
SELECT count(*)::int AS n FROM workflow_transitions WHERE created_at >= ${since}::timestamptz AND host = 'web'`);
  const count = Number(rows(res)[0]?.n ?? 0);
  const recent = count > 0 ? await recentTransitions({ since, ids: null, host: 'web', limit: WEB_RECENT_LIMIT }, exec) : [];
  return { count, recent };
}

export async function parkedCommands(since: string, exec: Exec = dbExec): Promise<ParkedView> {
  const [pending, dead] = await Promise.all([
    exec(sql`-- kernel_operator:parked
SELECT op, count(*)::int AS n, min(created_at) AS oldest,
  count(*) FILTER (WHERE attempt_count > 0 AND last_error IS NOT NULL)::int AS failing,
  (array_agg(last_error ORDER BY updated_at DESC) FILTER (WHERE last_error IS NOT NULL))[1] AS last_error
FROM workflow_command_outbox WHERE status = 'pending'
GROUP BY op ORDER BY min(created_at) LIMIT 50`),
    exec(sql`-- kernel_operator:gave_up
SELECT count(*)::int AS n FROM workflow_command_outbox WHERE status = 'dead' AND created_at >= ${since}::timestamptz`),
  ]);
  const byOp: ParkedOp[] = rows(pending).map((r) => ({
    op: String(r.op), count: Number(r.n), oldestAt: iso(r.oldest), failing: Number(r.failing), lastError: str(r.last_error)?.slice(0, 200) ?? null,
  }));
  return {
    total: byOp.reduce((a, b) => a + b.count, 0),
    oldestAt: byOp.length ? byOp.map((o) => o.oldestAt).sort()[0]! : null,
    byOp,
    gaveUp: Number(rows(dead)[0]?.n ?? 0),
  };
}

const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
const obj = (v: unknown): J | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);
const plural = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;

/** One floor run's recorded result, in plain words: what it repaired, and what it could not. */
export function describeFloorResult(result: J | null): { repaired: string[]; problems: string[] } {
  const repaired: string[] = [];
  const problems: string[] = [];
  if (!result) return { repaired, problems };
  const step = (key: string): J | null => {
    const v = obj(result[key]);
    if (v && typeof v.error === 'string') { problems.push(`${key} could not run: ${v.error.slice(0, 160)}`); return null; }
    return v;
  };
  const outbox = step('kernelOutbox');
  if (outbox) {
    if (n(outbox.done)) repaired.push(`sent ${plural(n(outbox.done), 'owed effect', 'owed effects')}`);
    if (n(outbox.failed)) problems.push(`${plural(n(outbox.failed), 'owed effect', 'owed effects')} failed to send`);
  }
  const floor = step('kernelFloor');
  if (floor) {
    if (n(floor.imported)) repaired.push(`took in ${plural(n(floor.imported), 'change', 'changes')} GitHub had already made`);
    if (n(floor.enqueued)) repaired.push(`re-queued ${plural(n(floor.enqueued), 'effect', 'effects')} a PR was owed`);
    if (n(floor.errors)) problems.push(`${plural(n(floor.errors), 'PR', 'PRs')} could not be read`);
  }
  const trunk = step('trunk');
  if (trunk) {
    if (n(trunk.resolved)) repaired.push(`cleared ${plural(n(trunk.resolved), 'base-branch incident', 'base-branch incidents')}`);
    if (n(trunk.errors)) problems.push(`${plural(n(trunk.errors), 'base-branch incident', 'base-branch incidents')} could not be checked`);
  }
  const tread = step('treadmillCycles');
  if (tread) {
    if (n(tread.restarted)) repaired.push(`restarted ${plural(n(tread.restarted), 'spent merge cycle', 'spent merge cycles')}`);
    if (n(tread.errors)) problems.push(`${plural(n(tread.errors), 'merge cycle', 'merge cycles')} could not be restarted`);
  }
  const parked = step('parkedCommands');
  if (parked) {
    if (n(parked.done)) repaired.push(`re-sent ${plural(n(parked.done), 'parked command', 'parked commands')}`);
    if (n(parked.dead)) problems.push(`gave up on ${plural(n(parked.dead), 'parked command', 'parked commands')}`);
  }
  const open = step('openPrStatuses');
  if (open) {
    const wrote = n(open.published) + n(open.republished);
    if (wrote) repaired.push(`wrote the approval check on ${plural(wrote, 'PR head', 'PR heads')}`);
    const missing = obj(open.coverage)?.missing;
    if (Array.isArray(missing) && missing.length) problems.push(`${plural(missing.length, 'open PR head', 'open PR heads')} still without the approval check`);
    if (n(open.errors)) problems.push(`${plural(n(open.errors), 'open PR head', 'open PR heads')} could not be read`);
  }
  const dead = step('deadEffects');
  if (dead) {
    if (n(dead.closed)) repaired.push(`closed ${plural(n(dead.closed), 'dead effect', 'dead effects')} as superseded`);
    if (n(dead.live)) problems.push(`${plural(n(dead.live), 'dead effect', 'dead effects')} still owed to a live delivery`);
  }
  const trunkErr = typeof result.commandsPruned === 'object' && obj(result.commandsPruned)?.error;
  if (typeof trunkErr === 'string') problems.push(`pruning old commands failed: ${trunkErr.slice(0, 160)}`);
  return { repaired, problems };
}

export async function lastFloorRuns(exec: Exec = dbExec): Promise<FloorRun[]> {
  // The control plane records `kernel-floor`; the web host runs the same pass inside the hourly `pr-reconcile`.
  const pick = sql`id, job, started_at, duration_ms, ok, error, jsonb_build_object(
    'host', result->>'host', 'kernelHost', result->>'kernelHost', 'kernelOutbox', result->'kernelOutbox', 'trunk', result->'trunk',
    'kernelFloor', result->'kernelFloor', 'treadmillCycles', result->'treadmillCycles', 'commandsPruned', result->'commandsPruned',
    'parkedCommands', result->'parkedCommands', 'openPrStatuses', result->'openPrStatuses', 'deadEffects', result->'deadEffects') AS result`;
  const res = await exec(sql`-- kernel_operator:floor_runs
SELECT * FROM (
  (SELECT ${pick} FROM cron_runs WHERE job = 'kernel-floor' ORDER BY started_at DESC LIMIT ${FLOOR_RUN_LIMIT})
  UNION ALL
  (SELECT ${pick} FROM cron_runs WHERE job = 'pr-reconcile' AND started_at >= now() - interval '7 days' AND result ? 'kernelOutbox' ORDER BY started_at DESC LIMIT ${FLOOR_RUN_LIMIT})
) runs ORDER BY started_at DESC LIMIT ${FLOOR_RUN_LIMIT}`);
  return rows(res).map((r) => {
    const result = obj(r.result);
    const { repaired, problems } = describeFloorResult(result);
    if (typeof r.error === 'string' && r.error) problems.unshift(`the run stopped: ${r.error.slice(0, 160)}`);
    return {
      id: String(r.id), startedAt: iso(r.started_at), durationMs: r.duration_ms == null ? null : Number(r.duration_ms), ok: r.ok === true,
      host: r.job === 'kernel-floor' ? 'control plane' : 'web', repaired, problems,
    };
  });
}

/** Evidence as one short line: `key: value` pairs, long values cut. */
export function evidenceLine(evidence: unknown): string {
  const e = obj(evidence);
  if (!e) return '';
  const parts = Object.entries(e).map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${(text ?? '').length > 80 ? `${text!.slice(0, 79)}…` : text}`;
  });
  const line = parts.join('; ');
  return line.length > 400 ? `${line.slice(0, 399)}…` : line;
}

export async function prTimeline(o: { ids: string[]; prNumber: number }, exec: Exec = dbExec): Promise<TimelineResult> {
  const found = rows(await exec(sql`-- kernel_operator:timeline_deliveries
SELECT d.id, d.repo_full_name, d.pr_number, d.state, d.state_reason, w.name AS workspace_name
FROM workflow_deliveries d JOIN workspaces w ON w.id = d.workspace_id
WHERE d.workspace_id IN ${idList(o.ids)} AND d.pr_number = ${o.prNumber}
ORDER BY d.updated_at DESC LIMIT ${TIMELINE_DELIVERIES}`));
  if (found.length === 0) return { kind: 'not_found', prNumber: o.prNumber };
  const timelines: PrTimeline[] = [];
  for (const d of found) {
    const deliveryId = String(d.id);
    const [stepRows, view] = await Promise.all([
      exec(sql`-- kernel_operator:timeline_steps
SELECT to_version, command, from_state, to_state, actor, host, created_at, evidence, bypass IS NOT NULL AS bypassed
FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid ORDER BY to_version LIMIT ${TIMELINE_LIMIT + 1}`),
      loadView({ deliveryId }, exec),
    ]);
    const all = rows(stepRows);
    const steps: TimelineStep[] = all.slice(0, TIMELINE_LIMIT).map((r) => ({
      version: Number(r.to_version), command: String(r.command), fromState: str(r.from_state), toState: String(r.to_state),
      actor: String(r.actor), host: str(r.host), at: iso(r.created_at), evidence: evidenceLine(r.evidence), bypassed: r.bypassed === true,
    }));
    const status = landingStatusOf(view);
    timelines.push({
      deliveryId, repo: str(d.repo_full_name), prNumber: Number(d.pr_number), state: String(d.state), stateReason: str(d.state_reason),
      workspaceName: String(d.workspace_name ?? ''), steps, stepsOmitted: Math.max(0, all.length - TIMELINE_LIMIT),
      openFindings: (view.findings ?? []).filter((f) => f.status === 'open').map((f) => `${f.required ? '' : '(advice) '}${describeFinding(f)}`),
      approval: status ? { state: status.state, description: status.description } : null,
      approvalContext: LANDING_STATUS_CONTEXT,
    });
  }
  return { kind: 'found', timelines };
}

export async function loadKernelOperatorView(query: KernelQuery, exec: Exec = dbExec): Promise<KernelOperatorView> {
  const now = query.now ?? Date.now();
  const since = new Date(now - KERNEL_WINDOWS[query.window]).toISOString();
  const scope = await resolveScope(query, exec);
  const command = query.command?.trim() || undefined;
  const timeline = (async (): Promise<TimelineResult> => {
    if (query.pr == null) return { kind: 'idle' };
    if (!query.workspace?.trim() && !query.team?.trim()) return { kind: 'needs_workspace' };
    if (!scope.ids || scope.ids.length === 0) return { kind: 'no_workspace', scope: scope.missing ?? '' };
    return prTimeline({ ids: scope.ids, prNumber: query.pr }, exec);
  })();
  const [transitions, web, parked, floorRuns, deadEffects, tl] = await Promise.all([
    scope.ids && scope.ids.length === 0 ? Promise.resolve([]) : recentTransitions({ since, ids: scope.ids, command, limit: TRANSITION_LIMIT }, exec),
    webHostTransitions(since, exec),
    parkedCommands(since, exec),
    lastFloorRuns(exec),
    liveDeadEffects(exec),
    timeline,
  ]);
  return { query, since, now, scopeMissing: scope.missing, transitions, web, parked, floorRuns, deadEffects, timeline: tl };
}
