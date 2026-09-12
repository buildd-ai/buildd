/**
 * Fleet-idle detector — the second pass of /api/cron/queue-stall, reached with
 * `?scope=fleet-idle`.
 *
 * ── The condition nothing could express ─────────────────────────────────────
 * A runner's claim circuit breaker tripped and it refused EVERY claim for
 * hours while remaining, by every signal the server has, perfectly healthy:
 * heartbeating on cadence, Pusher-connected, zero active workers. Tasks piled
 * up in `pending`. Nothing alerted, because:
 *
 *   1. The heartbeat cannot express "alive but refusing work". A fully-paused
 *      runner writes a row byte-identical to a healthy idle one — fresh
 *      `lastHeartbeatAt`, `activeWorkerCount: 0`. There is no server-side
 *      field for claim refusal; the runner's own reason (its claims.log
 *      diagnostic, its circuit-breaker events) never leaves the host.
 *   2. The gate pass could not have fired. Its threshold is measured from
 *      `tasks.createdAt` in hours and its schedule is daytime-only, so a
 *      freeze that starts in the evening has its whole window inside the
 *      nightly gap — and by the morning tick the piled-up tasks have been
 *      claimed and are filtered out by the never-claimed filter. On a lucky
 *      hit it would have rendered `no_gate_identified` as "no runner is
 *      offering role X", pointing at an offline runner while the runner was
 *      online.
 *
 * So this pass asks a different question, at the fleet level rather than the
 * task level: **is this account's fleet transacting at all?**
 *
 *   fresh heartbeat with spare capacity
 *   AND claimable pending work older than the threshold
 *   AND no worker has started inside the threshold
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 *   - NOT "runner offline". That is the heartbeat-stale rule in
 *     `cron/schedules/maintenance/stale-workers.ts`, which pages through the
 *     `runner-offline` ops source. Requiring a FRESH heartbeat here is what
 *     keeps one outage from paging twice; muted alerts detect nothing.
 *   - NOT "no work queued". Zero claimable tasks is normal idle and must stay
 *     silent, or a 24-hour detector pages every night on an empty queue.
 *   - NOT a task verdict. The gate pass answers "is THIS task permanently
 *     gated" and pays HTTP connector probes to do it. This pass emits one
 *     answer per account and touches no network at all, which is precisely
 *     what earns it 24-hour coverage.
 *
 * ── Why `workers.startedAt` ─────────────────────────────────────────────────
 * It is the only column that separates "nothing has begun" from "things are
 * running slowly". Claims, leases and heartbeats all continue during a freeze;
 * a worker row with a `startedAt` is proof that the claim→dispatch→start path
 * completed end to end.
 */

import { db } from '@buildd/core/db';
import {
  accountWorkspaces,
  tasks,
  workerHeartbeats,
  workers,
  workspaces,
} from '@buildd/core/db/schema';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { reportOps } from '@buildd/core/report-ops';
import {
  DEP_SATISFYING_STATUSES,
  DEP_UNBLOCKING_PR_LIFECYCLE,
} from '@/lib/dep-gate-contract';
import { hasBypassFlag, BYPASS_DEPS_GATE_KEY } from '@/lib/bypass-flags';

/**
 * How long a live fleet may hold claimable work without starting anything.
 *
 * 45 minutes. Pusher delivers an assignment in seconds and a claimable task is
 * picked up within a minute or two of becoming claimable, so 45 minutes of
 * "claimable work present, nothing started" is not a slow queue — it is a
 * fleet that is not transacting.
 *
 * Deliberately far tighter than the gate pass's 4 HOURS, because it is a
 * different question. 4h is right for "is this specific task permanently
 * gated": its false positives cost per-task HTTP probes, and a legitimate
 * queue wait behind the concurrency cap can be long. This pass emits at most
 * one answer per account from indexed aggregates, and the condition it names
 * self-clears the moment anything starts.
 */
export const FLEET_IDLE_THRESHOLD_MINUTES = 45;
const FLEET_IDLE_THRESHOLD_MS = FLEET_IDLE_THRESHOLD_MINUTES * 60_000;

/**
 * How recent a heartbeat must be to count as "the runner is alive".
 *
 * 10 minutes — ten missed beats at the runner's 60s cadence. Tight on purpose:
 * the whole alarm rests on the runner being demonstrably up, and the offline
 * case belongs to the heartbeat-stale rule (which fires at its own, much wider
 * threshold). The band between the two is a deliberate silence: a runner last
 * seen half an hour ago is on its way to being reported as offline, and saying
 * nothing beats saying it twice.
 */
export const HEARTBEAT_FRESH_MINUTES = 10;
const HEARTBEAT_FRESH_MS = HEARTBEAT_FRESH_MINUTES * 60_000;

/** Widest pending scan; oldest-first so the longest waits are never crowded out. */
const MAX_PENDING_SCAN = 500;

/** Bound on the per-account last-start probes a single run will issue. */
const MAX_ACCOUNTS_PER_RUN = 25;

interface FleetIdleFinding {
  accountId: string;
  /** Claimable pending tasks this account could have started and did not. */
  claimablePending: number;
  /** Null when no worker has ever started for this account. */
  lastStartedAt: string | null;
  /** Null for the same reason — there is no duration to measure. */
  idleMinutes: number | null;
  heartbeatAgeSeconds: number;
}

export interface FleetIdleResult {
  ok: true;
  scope: 'fleet-idle';
  thresholdMinutes: number;
  heartbeatFreshMinutes: number;
  /** Accounts with a fresh heartbeat and spare capacity. */
  accountsChecked: number;
  /** Claimable pending tasks attributable to at least one checked account. */
  claimablePending: number;
  alarms: number;
  findings: FleetIdleFinding[];
}

function quiet(over: Partial<FleetIdleResult> = {}): FleetIdleResult {
  return {
    ok: true,
    scope: 'fleet-idle',
    thresholdMinutes: FLEET_IDLE_THRESHOLD_MINUTES,
    heartbeatFreshMinutes: HEARTBEAT_FRESH_MINUTES,
    accountsChecked: 0,
    claimablePending: 0,
    alarms: 0,
    findings: [],
    ...over,
  };
}

interface LiveAccount {
  lastHeartbeatAt: Date;
  /** At least one of the account's fresh runners has a free worker slot. */
  spareCapacity: boolean;
}

/**
 * Accounts whose runners are alive AND able to accept work.
 *
 * The capacity half matters: a runner at `maxConcurrentWorkers` is refusing
 * claims CORRECTLY, and pages about it would be the nightly false positive
 * that gets a detector muted. The incident runner had zero active workers.
 */
async function liveAccounts(now: Date): Promise<Map<string, LiveAccount>> {
  const cutoff = new Date(now.getTime() - HEARTBEAT_FRESH_MS);
  const rows = await db.query.workerHeartbeats.findMany({
    where: gt(workerHeartbeats.lastHeartbeatAt, cutoff),
    columns: {
      accountId: true,
      lastHeartbeatAt: true,
      activeWorkerCount: true,
      maxConcurrentWorkers: true,
    },
  });

  const live = new Map<string, LiveAccount>();
  for (const hb of rows as Array<{
    accountId: string;
    lastHeartbeatAt: Date | string;
    activeWorkerCount: number | null;
    maxConcurrentWorkers: number | null;
  }>) {
    const beat = new Date(hb.lastHeartbeatAt);
    // Re-checked in TypeScript, not only in SQL, and deliberately so: the
    // freshness predicate IS the line between this alarm and the
    // runner-offline one, and a predicate that lives only in a query builder
    // is invisible to every test that mocks the query builder.
    if (!(beat.getTime() > cutoff.getTime())) continue;
    const spare = (hb.activeWorkerCount ?? 0) < (hb.maxConcurrentWorkers ?? 0);
    const prev = live.get(hb.accountId);
    live.set(hb.accountId, {
      lastHeartbeatAt: prev && prev.lastHeartbeatAt > beat ? prev.lastHeartbeatAt : beat,
      spareCapacity: (prev?.spareCapacity ?? false) || spare,
    });
  }
  return live;
}

interface PendingRow {
  id: string;
  workspaceId: string;
  startAt: Date | null;
  createdAt: Date;
  dependsOn: string[] | null;
  context: Record<string, unknown> | null;
}

/**
 * Pending tasks that have been genuinely claimable for longer than the
 * threshold.
 *
 * Deferred (`startAt` in the future) and dependency-blocked work is excluded
 * from the definition rather than absorbed into the threshold — the same
 * choice the gate pass makes, and for the same reason: otherwise the threshold
 * has to be padded for waits that are working as designed.
 *
 * A task that only just became claimable is excluded too. Nothing can be
 * inferred from "no start" for work that has waited two minutes.
 */
async function claimablePendingTasks(now: Date): Promise<PendingRow[]> {
  const cutoff = new Date(now.getTime() - FLEET_IDLE_THRESHOLD_MS);

  const rows = (await db.query.tasks.findMany({
    where: and(
      eq(tasks.status, 'pending'),
      lte(tasks.createdAt, cutoff),
      or(isNull(tasks.startAt), lte(tasks.startAt, cutoff)),
    ),
    columns: {
      id: true,
      workspaceId: true,
      startAt: true,
      createdAt: true,
      dependsOn: true,
      // Read for the deps-gate bypass only. A force-started task IS claimable
      // even with an unsatisfied dependency, so omitting this would hide a
      // real freeze.
      context: true,
    },
    orderBy: asc(tasks.createdAt),
    limit: MAX_PENDING_SCAN,
  })) as unknown as PendingRow[];

  const waited = rows.filter(t => {
    const created = new Date(t.createdAt);
    if (created.getTime() > cutoff.getTime()) return false;
    if (t.startAt && new Date(t.startAt).getTime() > cutoff.getTime()) return false;
    return true;
  });
  if (waited.length === 0) return [];

  // ── Dependency gate ───────────────────────────────────────────────────────
  // Same contract the claim query enforces (DEP_SATISFYING_STATUSES, plus the
  // open-PR guard on a completed dep), imported from the shared module so this
  // cannot become a third drifting copy.
  const depIds = [
    ...new Set(
      waited
        .filter(t => !hasBypassFlag(t.context ?? {}, BYPASS_DEPS_GATE_KEY))
        .flatMap(t => (t.dependsOn ?? []) as string[]),
    ),
  ];
  if (depIds.length === 0) return waited;

  const depRows = (await db.query.tasks.findMany({
    where: inArray(tasks.id, depIds),
    columns: { id: true, status: true },
  })) as unknown as Array<{ id: string; status: string }>;
  const depStatus = new Map(depRows.map(d => [d.id, d.status]));

  const depPrRows = (await db.query.workers.findMany({
    where: and(
      inArray(workers.taskId, depIds),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
    ),
    columns: { taskId: true, prLifecycleStatus: true },
  })) as unknown as Array<{ taskId: string | null; prLifecycleStatus: string | null }>;
  const depWithOpenPr = new Set(
    depPrRows
      .filter(w => w.taskId && (w.prLifecycleStatus ?? '') !== DEP_UNBLOCKING_PR_LIFECYCLE)
      .map(w => w.taskId as string),
  );

  return waited.filter(t => {
    if (hasBypassFlag(t.context ?? {}, BYPASS_DEPS_GATE_KEY)) return true;
    for (const depId of t.dependsOn ?? []) {
      const status = depStatus.get(depId);
      // A dangling dep id can never be satisfied; an unsatisfying status still
      // blocks; a completed dep with an unmerged PR still blocks.
      if (!status) return false;
      if (!(DEP_SATISFYING_STATUSES as readonly string[]).includes(status)) return false;
      if (status === 'completed' && depWithOpenPr.has(depId)) return false;
    }
    return true;
  });
}

/**
 * Which of these accounts could claim each workspace's work.
 *
 * Mirrors the claim route's own resolution: an `open` workspace is claimable
 * by any account, a `restricted` one only with a `canClaim` grant. Read
 * straight from the table rather than through the cached permissions helper,
 * which reaches for Redis — this pass makes no network calls, and that is the
 * property that lets it run at 03:00.
 */
async function claimableWorkspacesByAccount(
  accountIds: string[],
  workspaceIds: string[],
): Promise<{ open: Set<string>; granted: Map<string, Set<string>>; names: Map<string, string> }> {
  const open = new Set<string>();
  const names = new Map<string, string>();
  const granted = new Map<string, Set<string>>();
  if (workspaceIds.length === 0) return { open, granted, names };

  const wsRows = (await db.query.workspaces.findMany({
    where: inArray(workspaces.id, workspaceIds),
    columns: { id: true, name: true, accessMode: true },
  })) as unknown as Array<{ id: string; name: string | null; accessMode: string | null }>;
  for (const ws of wsRows) {
    if (ws.accessMode === 'open') open.add(ws.id);
    if (ws.name) names.set(ws.id, ws.name);
  }

  const linkRows = (await db.query.accountWorkspaces.findMany({
    where: inArray(accountWorkspaces.accountId, accountIds),
    columns: { accountId: true, workspaceId: true, canClaim: true },
  })) as unknown as Array<{ accountId: string; workspaceId: string; canClaim: boolean }>;
  for (const link of linkRows) {
    if (!link.canClaim) continue;
    const set = granted.get(link.accountId) ?? new Set<string>();
    set.add(link.workspaceId);
    granted.set(link.accountId, set);
  }

  return { open, granted, names };
}

/** The account's most recent worker start, or null if it has never had one. */
async function lastWorkerStart(accountId: string): Promise<Date | null> {
  const rows = (await db.query.workers.findMany({
    // isNotNull is load-bearing, not decoration: Postgres orders DESC as NULLS
    // FIRST, so a single unstarted worker row would otherwise come back as the
    // "most recent start" and read as null → a false "never started".
    where: and(eq(workers.accountId, accountId), isNotNull(workers.startedAt)),
    columns: { startedAt: true },
    orderBy: desc(workers.startedAt),
    limit: 1,
  })) as unknown as Array<{ startedAt: Date | string | null }>;

  let latest: Date | null = null;
  for (const row of rows) {
    if (!row.startedAt) continue;
    const at = new Date(row.startedAt);
    if (!latest || at > latest) latest = at;
  }
  return latest;
}

/**
 * Run the fleet-idle pass. Pure indexed reads plus at most one ops alert per
 * account; no gate ladder, no HTTP.
 */
export async function detectFleetIdle(now: Date = new Date()): Promise<FleetIdleResult> {
  const live = await liveAccounts(now);
  const candidates = [...live.entries()]
    .filter(([, acct]) => acct.spareCapacity)
    .map(([accountId]) => accountId);
  if (candidates.length === 0) return quiet();

  const pending = await claimablePendingTasks(now);
  if (pending.length === 0) return quiet({ accountsChecked: candidates.length });

  const { open, granted, names } = await claimableWorkspacesByAccount(
    candidates,
    [...new Set(pending.map(t => t.workspaceId))],
  );

  const idleCutoff = new Date(now.getTime() - FLEET_IDLE_THRESHOLD_MS);
  const findings: FleetIdleFinding[] = [];
  const attributable = new Set<string>();

  for (const accountId of candidates.slice(0, MAX_ACCOUNTS_PER_RUN)) {
    const reachable = pending.filter(
      t => open.has(t.workspaceId) || granted.get(accountId)?.has(t.workspaceId),
    );
    if (reachable.length === 0) continue;
    for (const t of reachable) attributable.add(t.id);

    const lastStart = await lastWorkerStart(accountId);
    // Something started inside the window: the fleet is transacting, and a
    // queue that is merely long is not this alarm.
    if (lastStart && lastStart.getTime() > idleCutoff.getTime()) continue;

    const acct = live.get(accountId)!;
    const idleMinutes = lastStart
      ? Math.round((now.getTime() - lastStart.getTime()) / 60_000)
      : null;
    const workspaceLabel = [
      ...new Set(reachable.map(t => names.get(t.workspaceId) ?? t.workspaceId)),
    ]
      .slice(0, 3)
      .join(', ');

    const heartbeatAgeSeconds = Math.round(
      (now.getTime() - acct.lastHeartbeatAt.getTime()) / 1000,
    );

    findings.push({
      accountId,
      claimablePending: reachable.length,
      lastStartedAt: lastStart ? lastStart.toISOString() : null,
      idleMinutes,
      heartbeatAgeSeconds,
    });

    // Transport-level dedupe, unlike the gate pass. That pass stamps a context
    // key on the task it reports; a fleet-level alarm has no task row to stamp,
    // so the window has to live in reportOps' atomic per-key slot. The key is
    // stable per account: a freeze that lasts all night pages once per window,
    // and two accounts freezing are two alarms.
    await reportOps({
      source: 'fleet-idle',
      severity: 'error',
      message:
        `Fleet alive but claiming nothing — ${reachable.length} claimable task(s) queued, ` +
        (idleMinutes === null
          ? 'no worker has ever started'
          : `no worker started for ${idleMinutes}m`),
      detail:
        `account ${accountId} last heartbeat ${heartbeatAgeSeconds}s ago ` +
        `with a free worker slot, and has started nothing for over ${FLEET_IDLE_THRESHOLD_MINUTES}m ` +
        `while claimable work waits${workspaceLabel ? ` (${workspaceLabel})` : ''}. ` +
        `The runner is up and refusing to claim — check its claim loop (circuit breaker, paused ` +
        `context, quota-reset parsing), not the task gates. The gate pass reports per-task blocks.`,
      dedupeKey: `fleet-idle:${accountId}`,
    });
  }

  return quiet({
    accountsChecked: candidates.length,
    claimablePending: attributable.size,
    alarms: findings.length,
    findings,
  });
}
