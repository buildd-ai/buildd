/**
 * POST /api/cron/queue-stall
 *
 * Queue-stall watchdog. Nothing in this system alerted on "a task has been
 * pending for N hours and has never been claimed" — which is how a task sat
 * `pending` in production for 5 days, rendering as a normal QUEUED row while a
 * claim gate silently excluded it from the claim query. An audit of the claim
 * route found ~8 more conditions with the same property: they remove a task
 * from the claim query with no UI signal and no operator override.
 *
 * This route is the systemic backstop for all of them. It does NOT re-implement
 * gate logic — it reuses the same per-gate helpers `/api/tasks/[id]/start`
 * calls (the per-gate modules under `api/workers/claim/`) plus the shared
 * gate contracts
 * (`lib/dep-gate-contract.ts`, `lib/subject-gate-contract.ts`), so a new gate
 * added to /start is one import away from being reported here too.
 *
 * The value of the watchdog is NAMING THE CAUSE. "5 tasks are stalled" is
 * useless; every reported task carries the first gate that is actually blocking
 * it plus a human-readable detail (blocker titles, not ids/hashes).
 *
 * ── Never claimed, not "no worker" ──────────────────────────────────────────
 * The incident task had a worker row; that worker just failed. A task counts as
 * never-successfully-claimed unless it has a worker that is live
 * (LIVE_WORKER_STATUSES) or `completed`. Error/failed workers prove an attempt,
 * not progress.
 *
 * ── Not every pending task is stalled ───────────────────────────────────────
 * Two shapes return no report at all, because they are working as designed:
 *   - `startAt` in the future — the task is scheduled, not stuck.
 *   - a dependency that is still in flight — the upstream task is the one that
 *     gets reported if IT stalls; flagging the whole funnel would be noise.
 *
 * ── Reporting is not gating ─────────────────────────────────────────────────
 * `backend_credential_missing` names a task whose effective agent backend has no
 * usable credential. That condition deliberately has no `/start` gateReason: the
 * capability gate was removed in PR #1864 in favour of configuration-time
 * surfacing (Settings → Agent backends counts the same stranded work from the
 * same module). The watchdog reports it; it withholds nothing.
 *
 * ── Dedupe ──────────────────────────────────────────────────────────────────
 * Context-key dedupe, matching /api/cron/connector-block-notify: the first
 * alert stamps `context.queueStallNotifiedAt` + `queueStallGate` +
 * `queueStallDetail`. A task inside the renotify window is skipped entirely
 * (gate evaluation included — that is what keeps the connector HTTP probe off
 * the hot path). A gate that changes mid-window is picked up at the next
 * renotify, which is soon enough for a condition that has already been paged.
 *
 * Auth: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq, and, lt, inArray, isNull, isNotNull, asc } from 'drizzle-orm';
// Env-based ops Pushover (same channel /api/cron/stall-notify uses), NOT
// lib/notify's per-team routing: a queue stall is a platform-health signal, and
// notifyTeam() only accepts the five NotifyEvent values that have columns in
// notification_preferences — routing this through it would mean a schema change
// or mislabelling the alert as taskFailed.
import { notify } from '@/lib/pushover';
import { checkConnectorRouting } from '@/app/api/workers/claim/connector-gate';
import { checkMissionHeld } from '@/app/api/workers/claim/held-gate';
import { checkMissionBudgetExhausted } from '@/app/api/workers/claim/mission-budget-gate';
import { checkWorkspaceCap } from '@/app/api/workers/claim/workspace-cap-gate';
import { isSubjectDead } from '@/lib/subject-gate-contract';
// One definition of "is this operator bypass set", shared with the claim
// route's SQL prefilter and /start. This file previously carried a local copy
// that was byte-for-byte hasBypassFlag — a third copy of gate logic in the very
// job whose purpose is to catch gate logic drifting.
import { hasBypassFlag, BYPASS_DEPS_GATE_KEY, BYPASS_HELD_GATE_KEY, BYPASS_MISSION_BUDGET_KEY, CAP_EXEMPT_KEY } from '@/lib/bypass-flags';
import { declaresNoScope } from '@buildd/core/path-overlap';
// Reporting only. The credential state this reads has deliberately NO
// task-level gate (`capability_mismatch` / `checkCapabilityMatch` were removed
// in PR #1864 and replaced by configuration-time surfacing); the watchdog names
// the condition, it never withholds a task from anything.
import { createBackendStrandProbe } from '@/lib/backend-strand';
import {
  DEP_SATISFYING_STATUSES,
  DEP_UNBLOCKING_PR_LIFECYCLE,
} from '@/lib/dep-gate-contract';
import { LIVE_WORKER_STATUSES } from '@/lib/task-presentation';

export const maxDuration = 60;

/**
 * How long a task may sit pending-and-never-claimed before it is a stall.
 *
 * 4h, chosen against the longest LEGITIMATE queue wait: the only self-resolving
 * gate is the per-workspace concurrency cap (default 3 concurrent tasks), and a
 * task runs in tens of minutes, so a healthy queue drains a backlog well inside
 * 4h. Deferred (`startAt`) and in-flight-dependency waits are excluded from the
 * definition entirely rather than absorbed into the threshold, so the threshold
 * does not have to be padded for them.
 *
 * The incident took 5 days to notice. Hours is the target: with the hourly
 * daytime schedule below, worst case is "same working day".
 */
const STALL_THRESHOLD_HOURS = 4;

/**
 * Re-alert cadence for a task that is still stalled. 24h: long enough that a
 * permanently-gated task cannot page anyone daily-and-then-hourly into
 * banner-blindness, short enough that a stall nobody acted on comes back.
 */
const RENOTIFY_HOURS = 24;

/** Widest scan; oldest-first so the worst offenders are never crowded out. */
const MAX_CANDIDATES = 200;

/**
 * Gates are evaluated per task and `checkConnectorRouting` HTTP-probes each
 * connector a role requires (5s budget each). Cap the work per run so the
 * route cannot exceed maxDuration; the remainder is reported as deferred and
 * picked up next run.
 */
const MAX_TASKS_PER_RUN = 20;
const GATE_BUDGET_MS = 40_000;

/** Lines in the Pushover digest before it collapses into "+N more". */
const DIGEST_LINES = 5;

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev';

/** Worker statuses that prove the task was successfully claimed at least once. */
const PROGRESSING_WORKER_STATUSES = new Set<string>([
  ...LIVE_WORKER_STATUSES,
  'completed',
]);

export type StallGate =
  | 'dep_missing'
  | 'dep_failed'
  | 'unmerged_dep_pr'
  | 'connector_routing_mismatch'
  | 'mission_held'
  | 'mission_budget_exhausted'
  | 'subject_dead'
  | 'workspace_cap_reached'
  | 'backend_credential_missing'
  | 'advisory_manifest'
  | 'no_gate_identified';

interface CandidateWorkspace {
  id: string;
  name: string | null;
  teamId: string | null;
  repo: string | null;
  maxConcurrentTasks: number | null;
}

interface Candidate {
  id: string;
  title: string;
  workspaceId: string;
  backend: string | null;
  roleSlug: string | null;
  missionId: string | null;
  dependsOn: string[] | null;
  startAt: Date | null;
  createdAt: Date;
  context: Record<string, unknown> | null;
  subjectKind: string | null;
  subjectPrNumber: number | null;
  subjectResolution: string | null;
  subjectAnchor: { source?: string | null } | null;
  pathManifest: string[] | null;
  workspace?: CandidateWorkspace | null;
}

/**
 * missionId → the scope-undeclared task currently holding that mission's single
 * serialization slot in the claim loop (`declaresNoScope` + a live worker).
 * Empty unless an examined task actually has an undeclared scope, so a queue of
 * concrete-manifest tasks pays nothing for this.
 */
type AdvisoryPeerIndex = Map<string, { id: string; title: string }>;

interface DepIndex {
  byId: Map<string, { title: string; status: string }>;
  /** Dep task id → its still-open, still-unmerged PR (closed PRs excluded). */
  openPrByTaskId: Map<string, { prNumber: number | null; prUrl: string | null }>;
}

type BackendStrandProbe = ReturnType<typeof createBackendStrandProbe>;

interface GateVerdict {
  gate: StallGate;
  detail: string;
}

/**
 * The first claim gate actually blocking this task, or null when the task is
 * legitimately waiting (scheduled start / in-flight dependency).
 *
 * Evaluation order mirrors `/api/tasks/[id]/start` deliberately: an operator
 * who clicks Start on a reported task must see the same gateReason the
 * watchdog named. Notably the connector gate stays AHEAD of the concurrency cap
 * so a permanent capability block is never masked by a transient queue wait.
 *
 * Two gates have no /start counterpart and therefore sit BELOW every gate that
 * does, in permanence order: `backend_credential_missing` (permanent until an
 * operator adds a credential) then `advisory_manifest` (self-clearing). Both
 * only speak when /start would have returned 200, so /start's own 422 ordering
 * is reproduced verbatim.
 */
async function resolveStallGate(
  task: Candidate,
  deps: DepIndex,
  advisoryPeers: AdvisoryPeerIndex,
  strandProbe: BackendStrandProbe,
  now: Date,
): Promise<GateVerdict | null> {
  const ctx = task.context ?? {};

  // ── Deferred start ────────────────────────────────────────────────────────
  // Scheduled, not stalled. Mirrors isDeferredTaskClaimable().
  //
  // Unconditional: there is deliberately NO bypassStartGate flag. Nothing has
  // ever written that key, and /start expresses the deferred-start override by
  // clearing `startAt` outright — the only thing the claim query reads. Reading
  // a phantom key here meant a task with a stray context value would be walked
  // through the whole ladder and reported as stalled while it was merely
  // scheduled.
  if (task.startAt && task.startAt > now) {
    return null;
  }

  // ── Dependency gate (deps-gate.ts / dep-gate-contract.ts) ─────────────────
  const dependsOn = task.dependsOn ?? [];
  if (dependsOn.length > 0 && !hasBypassFlag(ctx, BYPASS_DEPS_GATE_KEY)) {
    const missing: string[] = [];
    const failed: string[] = [];
    const unmerged: string[] = [];
    let inFlight = 0;

    for (const depId of dependsOn) {
      const dep = deps.byId.get(depId);
      if (!dep) {
        // A dangling dep id can never be satisfied — the SQL gate's NOT EXISTS
        // stays false forever.
        missing.push(depId);
        continue;
      }
      if (dep.status === 'failed') {
        // `failed` is NOT in DEP_SATISFYING_STATUSES, so this blocks forever
        // unless something cascades the failure down.
        failed.push(dep.title);
        continue;
      }
      if (!(DEP_SATISFYING_STATUSES as readonly string[]).includes(dep.status)) {
        inFlight++;
        continue;
      }
      if (dep.status === 'completed') {
        const pr = deps.openPrByTaskId.get(depId);
        if (pr) unmerged.push(pr.prNumber ? `${dep.title} (PR #${pr.prNumber})` : dep.title);
      }
    }

    if (missing.length > 0) {
      return {
        gate: 'dep_missing',
        detail: `dependency id(s) no longer exist: ${missing.join(', ')}`,
      };
    }
    if (failed.length > 0) {
      return {
        gate: 'dep_failed',
        detail: `dependency failed and will never complete: ${failed.join(', ')}`,
      };
    }
    if (unmerged.length > 0) {
      return {
        gate: 'unmerged_dep_pr',
        detail: `dependency PR(s) not merged: ${unmerged.join(', ')}`,
      };
    }
    // Upstream still working — this task is queued behind it, not stalled.
    if (inFlight > 0) return null;
  }

  // ── Connector routing gate ────────────────────────────────────────────────
  const teamId = task.workspace?.teamId ?? null;
  if (task.roleSlug && teamId) {
    const failures = await checkConnectorRouting(task.roleSlug, task.workspaceId, teamId);
    if (failures && failures.length > 0) {
      const detail = failures.map(f => `'${f.connectorName}' (${f.mode})`).join(', ');
      return {
        gate: 'connector_routing_mismatch',
        detail: `role '${task.roleSlug}' requires unusable connector(s): ${detail}`,
      };
    }
  }

  // ── Mission held gate ─────────────────────────────────────────────────────
  if (task.missionId && !hasBypassFlag(ctx, BYPASS_HELD_GATE_KEY)) {
    if (await checkMissionHeld(task.missionId)) {
      return {
        gate: 'mission_held',
        detail: `parent mission ${task.missionId} is held — arm it or force-start the task`,
      };
    }
  }

  // ── Mission budget gate ───────────────────────────────────────────────────
  // The widest blast radius of any gate: `budget_exhausted` is a one-way door
  // (only a human raising costBudgetUsd clears it) and it strands EVERY task in
  // the mission simultaneously, each rendering as a plain QUEUED row. Placed
  // between the held gate and the subject gate to match /start exactly.
  if (task.missionId && !hasBypassFlag(ctx, BYPASS_MISSION_BUDGET_KEY)) {
    if (await checkMissionBudgetExhausted(task.missionId)) {
      return {
        gate: 'mission_budget_exhausted',
        detail: `parent mission ${task.missionId} has exhausted its cost budget — raise the budget to release every task in it, or force-start this one`,
      };
    }
  }

  // ── Subject-liveness gate ─────────────────────────────────────────────────
  if (
    isSubjectDead({
      subjectKind: task.subjectKind,
      subjectPrNumber: task.subjectPrNumber,
      subjectResolution: task.subjectResolution,
      subjectAnchor: task.subjectAnchor,
      context: task.context,
    })
  ) {
    return {
      gate: 'subject_dead',
      detail: `subject PR #${task.subjectPrNumber} is closed/merged with no live successor`,
    };
  }

  // ── Workspace concurrency cap ─────────────────────────────────────────────
  if (task.workspace?.repo && !hasBypassFlag(ctx, CAP_EXEMPT_KEY)) {
    const capResult = await checkWorkspaceCap(
      task.workspaceId,
      task.workspace.maxConcurrentTasks ?? null,
    );
    if (capResult) {
      return {
        gate: 'workspace_cap_reached',
        detail: `workspace at concurrency limit (${capResult.active}/${capResult.cap}) — a zombie worker holding a slot looks identical to a busy queue`,
      };
    }
  }

  // ── Missing backend credential ────────────────────────────────────────────
  // The effective backend (stored backend + the team's provider mask, resolved
  // by the one shared `resolveEffectiveBackend`) has no usable credential, so
  // the claim route either drops the task from the candidate set (the Codex
  // capability filter) or defers it as `provider_unavailable` on every poll —
  // forever, with no worker ever attempting it.
  //
  // This is the most permanent block the watchdog can see and it used to report
  // as `no_gate_identified` ("no runner is polling this workspace"), which sends
  // the operator to look at runners when the fix is one credential in Settings.
  // There is intentionally no /start gateReason for it, so it ranks below every
  // gate /start does name, and above the self-clearing `advisory_manifest`.
  {
    const stranded = await strandProbe.check({
      backend: task.backend,
      workspaceId: task.workspaceId,
      teamId,
    });
    if (stranded) {
      return {
        gate: 'backend_credential_missing',
        detail:
          `routed to ${stranded.label}, which has no credential for this team — ` +
          `no runner can claim it. Add one in Settings → Agent backends, or ` +
          `disable ${stranded.label} team-wide to reroute this work`,
      };
    }
  }

  // ── Advisory-manifest mission serialization ───────────────────────────────
  // The claim loop allows at most ONE scope-undeclared task per mission in
  // flight (declaresNoScope: null / [] / ['**']). Unlike every gate above this
  // one is a soft, self-clearing deferral, which is exactly why it is last: it
  // must never mask a permanent block, and the tasks that reach here have
  // already passed every gate /start knows about, so the alternative report is
  // the actively misleading `no_gate_identified` ("no runner is offering this
  // role") for a task a gate IS holding.
  //
  // It is reported at all because the 4h threshold has already filtered out
  // normal transience — the same reason `workspace_cap_reached` is in the
  // ladder. The realistic non-self-clearing case is a peer parked in
  // `waiting_input` (its worktree still holds edits, so the slot is genuinely
  // taken): that waits on a human answering a question, which can be days.
  if (task.missionId && declaresNoScope(task.pathManifest)) {
    const peer = advisoryPeers.get(task.missionId);
    if (peer && peer.id !== task.id) {
      return {
        gate: 'advisory_manifest',
        detail: `mission already has a scope-undeclared task in flight: "${peer.title}" — declare a pathManifest on either task, or unblock that one`,
      };
    }
  }

  // ── No gate found ─────────────────────────────────────────────────────────
  // The claim query would accept this task, so nothing is asking for it:
  // usually no runner online offering the role.
  return {
    gate: 'no_gate_identified',
    detail: task.roleSlug
      ? `no claim gate blocks it — no runner is offering role '${task.roleSlug}'`
      : 'no claim gate blocks it — no runner is polling this workspace',
  };
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const threshold = new Date(now.getTime() - STALL_THRESHOLD_HOURS * 3_600_000);
  const renotifyMs = RENOTIFY_HOURS * 3_600_000;

  const candidateRows = await db.query.tasks.findMany({
    where: and(eq(tasks.status, 'pending'), lt(tasks.createdAt, threshold)),
    columns: {
      id: true,
      title: true,
      workspaceId: true,
      // The effective-backend probe reads this. Unselected it would read as
      // undefined → resolved as the schema default ('claude'), which is
      // implicitly configured — i.e. the gate would silently never fire.
      backend: true,
      roleSlug: true,
      missionId: true,
      dependsOn: true,
      startAt: true,
      createdAt: true,
      context: true,
      subjectKind: true,
      subjectPrNumber: true,
      subjectResolution: true,
      subjectAnchor: true,
      // Feeds the advisory-manifest gate. Unselected reads as undefined, which
      // declaresNoScope() would (correctly) call "no scope declared" — so an
      // omission here turns the gate on for the entire queue rather than off.
      pathManifest: true,
    },
    with: {
      workspace: {
        columns: { id: true, name: true, teamId: true, repo: true, maxConcurrentTasks: true },
      },
    },
    orderBy: asc(tasks.createdAt),
    limit: MAX_CANDIDATES,
  });
  const candidates = candidateRows as unknown as Candidate[];

  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true,
      thresholdHours: STALL_THRESHOLD_HOURS,
      candidates: 0,
      examined: 0,
      deferred: 0,
      deduped: 0,
      notified: 0,
      stalled: [],
    });
  }

  // ── Filter out tasks that were successfully claimed at least once ─────────
  const candidateIds = candidates.map(t => t.id);
  const candidateWorkerRows = await db.query.workers.findMany({
    where: inArray(workers.taskId, candidateIds),
    columns: { taskId: true, status: true },
  });
  const progressed = new Set<string>();
  for (const w of candidateWorkerRows as Array<{ taskId: string | null; status: string }>) {
    if (w.taskId && PROGRESSING_WORKER_STATUSES.has(w.status)) progressed.add(w.taskId);
  }

  let deduped = 0;
  const eligible: Candidate[] = [];
  for (const task of candidates) {
    if (progressed.has(task.id)) continue;
    const notifiedAtStr = (task.context ?? {}).queueStallNotifiedAt as string | undefined;
    if (notifiedAtStr) {
      const notifiedAt = new Date(notifiedAtStr);
      if (!isNaN(notifiedAt.getTime()) && now.getTime() - notifiedAt.getTime() < renotifyMs) {
        deduped++;
        continue;
      }
    }
    eligible.push(task);
  }

  const examinedSet = eligible.slice(0, MAX_TASKS_PER_RUN);
  let deferredForNextRun = eligible.length - examinedSet.length;

  // ── Prefetch the dependency index for every examined task ────────────────
  const depIds = [
    ...new Set(examinedSet.flatMap(t => (t.dependsOn ?? []) as string[])),
  ];
  const deps: DepIndex = { byId: new Map(), openPrByTaskId: new Map() };
  if (depIds.length > 0) {
    const depRows = await db.query.tasks.findMany({
      where: inArray(tasks.id, depIds),
      columns: { id: true, title: true, status: true },
    });
    for (const d of depRows as Array<{ id: string; title: string; status: string }>) {
      deps.byId.set(d.id, { title: d.title, status: d.status });
    }

    const depPrRows = await db.query.workers.findMany({
      where: and(
        inArray(workers.taskId, depIds),
        isNotNull(workers.prUrl),
        isNull(workers.mergedAt),
      ),
      columns: { taskId: true, prUrl: true, prNumber: true, prLifecycleStatus: true },
    });
    for (const w of depPrRows as Array<{
      taskId: string | null;
      prUrl: string | null;
      prNumber: number | null;
      prLifecycleStatus: string | null;
    }>) {
      // A closed/abandoned PR unblocks dependents (DEP_UNBLOCKING_PR_LIFECYCLE).
      if (!w.taskId) continue;
      if ((w.prLifecycleStatus ?? '') === DEP_UNBLOCKING_PR_LIFECYCLE) continue;
      if (!deps.openPrByTaskId.has(w.taskId)) {
        deps.openPrByTaskId.set(w.taskId, { prNumber: w.prNumber, prUrl: w.prUrl });
      }
    }
  }

  // ── Advisory-manifest peer index ──────────────────────────────────────────
  // Only queried when an examined task actually has an undeclared scope AND a
  // mission — the gate is mission-scoped, so a mission-less task can never hit
  // it and a concrete-manifest queue skips the round trip entirely.
  const advisoryPeers: AdvisoryPeerIndex = new Map();
  const advisoryMissionIds = [...new Set(
    examinedSet
      .filter(t => t.missionId && declaresNoScope(t.pathManifest))
      .map(t => t.missionId as string),
  )];
  if (advisoryMissionIds.length > 0) {
    const peerRows = await db.query.tasks.findMany({
      where: inArray(tasks.missionId, advisoryMissionIds),
      columns: { id: true, title: true, missionId: true, pathManifest: true },
      with: {
        // LIVE_WORKER_STATUSES is the same in-flight set the claim loop's guard
        // uses — `waiting_input` included, because that worker's worktree still
        // holds uncommitted edits and the slot is genuinely taken.
        workers: { columns: { status: true } },
      },
    });
    for (const peer of peerRows as Array<{
      id: string;
      title: string;
      missionId: string | null;
      pathManifest: string[] | null;
      workers?: Array<{ status: string }> | null;
    }>) {
      if (!peer.missionId || advisoryPeers.has(peer.missionId)) continue;
      if (!declaresNoScope(peer.pathManifest)) continue;
      const inFlight = (peer.workers ?? []).some(
        w => (LIVE_WORKER_STATUSES as readonly string[]).includes(w.status),
      );
      if (!inFlight) continue;
      advisoryPeers.set(peer.missionId, { id: peer.id, title: peer.title });
    }
  }

  // ── Evaluate gates ────────────────────────────────────────────────────────
  interface StalledReport {
    taskId: string;
    title: string;
    workspaceId: string;
    workspaceName: string | null;
    ageHours: number;
    gate: StallGate;
    detail: string;
    url: string;
  }

  const stalled: StalledReport[] = [];
  const gateStart = Date.now();
  // One probe per run: the provider mask is read once per team and each
  // credential lookup once per (backend, workspace), however long the queue is.
  const strandProbe = createBackendStrandProbe();

  for (let i = 0; i < examinedSet.length; i++) {
    if (Date.now() - gateStart > GATE_BUDGET_MS) {
      deferredForNextRun += examinedSet.length - i;
      break;
    }
    const task = examinedSet[i];
    let verdict: GateVerdict | null = null;
    try {
      verdict = await resolveStallGate(task, deps, advisoryPeers, strandProbe, now);
    } catch (err) {
      // A gate helper throwing must not blind the whole run — report it as its
      // own finding rather than losing the task.
      console.error(`[queue-stall] gate evaluation failed for task ${task.id}:`, err);
      verdict = {
        gate: 'no_gate_identified',
        detail: `gate evaluation errored: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!verdict) continue;

    stalled.push({
      taskId: task.id,
      title: task.title,
      workspaceId: task.workspaceId,
      workspaceName: task.workspace?.name ?? null,
      ageHours: Math.round((now.getTime() - new Date(task.createdAt).getTime()) / 3_600_000),
      gate: verdict.gate,
      detail: verdict.detail,
      url: `${APP_BASE_URL}/app/tasks/${task.id}`,
    });
  }

  // ── Notify once per run, naming every cause ───────────────────────────────
  let notified = 0;
  if (stalled.length > 0) {
    const lines = stalled
      .slice(0, DIGEST_LINES)
      .map(
        s =>
          `• "${s.title}" (${s.workspaceName ?? s.workspaceId}) pending ${s.ageHours}h — ${s.gate}: ${s.detail}`,
      );
    if (stalled.length > DIGEST_LINES) {
      lines.push(`• +${stalled.length - DIGEST_LINES} more (see /api/cron/queue-stall response)`);
    }

    const title =
      stalled.length === 1
        ? `[buildd] Task stalled ${stalled[0].ageHours}h — ${stalled[0].gate}`
        : `[buildd] ${stalled.length} tasks stalled in queue`;

    notify({
      app: 'alerts',
      title,
      message: lines.join('\n'),
      priority: 0,
      url: stalled.length === 1 ? stalled[0].url : `${APP_BASE_URL}/app/tasks`,
      urlTitle: stalled.length === 1 ? 'View task' : 'View queue',
    });

    // Stamp dedupe context per task (connector-block-notify pattern).
    for (const s of stalled) {
      const task = examinedSet.find(t => t.id === s.taskId);
      const ctx = (task?.context ?? {}) as Record<string, unknown>;
      await db
        .update(tasks)
        .set({
          context: {
            ...ctx,
            queueStallNotifiedAt: now.toISOString(),
            queueStallGate: s.gate,
            queueStallDetail: s.detail,
          },
          updatedAt: now,
        })
        .where(eq(tasks.id, s.taskId));
    }
    notified = stalled.length;

    console.log(
      JSON.stringify({
        event: 'queue_stall_detected',
        thresholdHours: STALL_THRESHOLD_HOURS,
        count: stalled.length,
        gates: stalled.map(s => ({ taskId: s.taskId, gate: s.gate, ageHours: s.ageHours })),
      }),
    );
  }

  return NextResponse.json({
    ok: true,
    thresholdHours: STALL_THRESHOLD_HOURS,
    candidates: candidates.length,
    examined: examinedSet.length,
    deferred: deferredForNextRun,
    deduped,
    notified,
    stalled,
  });
}
