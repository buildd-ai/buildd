/**
 * Authoritative working set — server half (docs/specs/path-claim-ownership.md).
 *
 * `path_claims` rows ARE the current task-owned file set. The runner tracks the
 * set from git and sends what changed since the last ACK; this module turns one
 * such delta into lease rows, in a bounded number of statements regardless of
 * how many paths the delta carries:
 *
 *   add    → one exclusive acquisition (`acquirePathClaims`, one locked
 *            statement for the whole chunk; own leases are no-ops, so a
 *            repeated delta is idempotent)
 *   remove → one read of the task's active leases on those paths, one locked
 *            release of exactly those rows (`releaseLeaseRows`), which also
 *            wakes the waiters blocked on them. Never the manifest: a working
 *            set is runtime truth, the manifest is scheduling intent.
 *
 * `workers.observedTouches` is not consulted and not written here. A worker
 * row never holds the set — it holds a bounded diagnostic sample (route.ts).
 *
 * Pusher/agent delivery for the woken waiters is the caller's
 * (`deliverPathReleased`), as everywhere else in this layer.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PathCollisionNotice, PrHandoffRecord, WorkingSetAck, WorkingSetDelta, WorkingSetRecord } from '@buildd/shared';
import { WORKING_SET_HELD_CAP } from '@buildd/shared';
import { db } from './db/client';
import { pathClaims, tasks } from './db/schema';
import {
  acquirePathClaims,
  releaseLeaseRows,
  type BlockedPath,
  type ReleaseResult,
} from './path-claim';
import { leasablePaths, REPO_WIDE_SENTINEL, stripTrailingSep } from './path-overlap';

export { leasablePaths };

export interface ReconcileWorkingSetInput {
  workspaceId: string;
  taskId: string;
  delta: Pick<WorkingSetDelta, 'generation' | 'add' | 'remove' | 'complete' | 'includeHeld'>;
  /** A read-only reviewer never leases: it reports the PR diff it checked out. */
  readOnly?: boolean;
}

export interface ReconcileWorkingSetResult {
  ack: WorkingSetAck;
  /** Blocked paths with the holder's lease, for the collision notice. */
  blocked: BlockedPath[];
  /** Release result for the caller to deliver, when something was released or woken. */
  release: ReleaseResult | null;
  /** Wall-clock cost of the DB work, for the size-bucket instrumentation. */
  latencyMs: number;
  /** Size bucket of this delta (add + remove): the knob to watch before inventing compression. */
  sizeBucket: WorkingSetSizeBucket;
}

export type WorkingSetSizeBucket = '<=50' | '<=500' | '<=2k' | '>2k';

export function workingSetSizeBucket(n: number): WorkingSetSizeBucket {
  if (n <= 50) return '<=50';
  if (n <= 500) return '<=500';
  if (n <= 2000) return '<=2k';
  return '>2k';
}

/** This task's active lease rows (`id` + `path`). */
export async function activeLeases(workspaceId: string, taskId: string): Promise<Array<{ id: string; path: string }>> {
  const rows = await db.query.pathClaims.findMany({
    where: and(eq(pathClaims.workspaceId, workspaceId), eq(pathClaims.taskId, taskId), isNull(pathClaims.releasedAt)),
    columns: { id: true, path: true },
  });
  return rows.map(r => ({ id: String(r.id), path: r.path }));
}

/** Paths this task currently holds — the authoritative current working set. */
export async function activeLeasePaths(workspaceId: string, taskId: string): Promise<string[]> {
  return (await activeLeases(workspaceId, taskId)).map(r => r.path);
}

/**
 * Apply one delta. Idempotent: re-sending the same delta acquires nothing new
 * and releases nothing twice. `remove` only ever frees exact leases on the
 * named paths — a declared directory lease above a reverted file is untouched.
 */
export async function reconcileWorkingSet(input: ReconcileWorkingSetInput): Promise<ReconcileWorkingSetResult> {
  const started = Date.now();
  const { workspaceId, taskId, delta } = input;
  const add = leasablePaths(delta.add);
  const remove = leasablePaths(delta.remove);
  const sizeBucket = workingSetSizeBucket(add.length + remove.length);

  let acquired: string[] = [];
  let blocked: BlockedPath[] = [];
  let applied = true;
  if (add.length > 0 && !input.readOnly) {
    const result = await acquirePathClaims({ workspaceId, taskId, paths: add, declare: false });
    if (result.kind === 'acquired') {
      acquired = result.inserted;
      blocked = result.blocked;
    } else if (result.kind === 'conflict') {
      blocked = result.blocked;
    } else {
      // The task is no longer open: nothing leased, and the runner must not
      // count this as coverage.
      applied = false;
    }
  }

  let released: string[] = [];
  let release: ReleaseResult | null = null;
  if (remove.length > 0) {
    const held = await activeLeases(workspaceId, taskId);
    const want = new Set(remove);
    const ids = held.filter(h => want.has(stripTrailingSep(h.path))).map(h => h.id);
    if (ids.length > 0) {
      const r = await releaseLeaseRows({ workspaceId, taskId, leaseIds: ids, keepStatuses: [] });
      if (r.kind === 'released') {
        released = r.result.releasedPaths;
        release = r.result;
      }
    }
  }

  const heldRows = await activeLeases(workspaceId, taskId);
  const heldPaths = delta.includeHeld
    ? heldRows.map(h => h.path).sort().slice(0, WORKING_SET_HELD_CAP)
    : undefined;

  const notices: PathCollisionNotice[] = blocked.map(b => ({
    path: b.path, blockingTaskId: b.blockingTaskId, blockingTaskTitle: null, blockingPath: b.blockingPath,
  }));
  const coverage: WorkingSetAck['coverage'] = blocked.length > 0 ? 'blocked' : delta.complete && applied ? 'complete' : 'partial';

  return {
    ack: {
      generation: delta.generation,
      acquired,
      blocked: notices,
      released,
      heldCount: heldRows.length,
      ...(heldPaths ? { heldPaths } : {}),
      applied,
      coverage,
    },
    blocked,
    release,
    latencyMs: Date.now() - started,
    sizeBucket,
  };
}

/** Bounded proof to keep on `tasks.path_declaration.workingSet`. */
export function workingSetRecord(input: {
  ack: WorkingSetAck;
  checkpoint: WorkingSetDelta['checkpoint'] | null | undefined;
  workerId: string | null;
  now?: Date;
}): WorkingSetRecord {
  return {
    generation: input.ack.generation,
    coverage: input.ack.coverage,
    heldCount: input.ack.heldCount,
    blockedCount: input.ack.blocked.length,
    blockedSample: input.ack.blocked.slice(0, 10).map(b => ({ path: b.path, blockingTaskId: b.blockingTaskId })),
    checkpoint: input.checkpoint ?? null,
    workerId: input.workerId,
    at: (input.now ?? new Date()).toISOString(),
  };
}

/** Merge `record` into `tasks.path_declaration.workingSet`, keeping the declaration snapshot. */
export async function recordWorkingSet(workspaceId: string, taskId: string, record: WorkingSetRecord): Promise<void> {
  await db.update(tasks).set({
    pathDeclaration: sql`COALESCE(${tasks.pathDeclaration}, jsonb_build_object(
      'declared', ${tasks.pathManifest}, 'source', 'runtime', 'snapshotAt', now()))
      || jsonb_build_object('workingSet', ${JSON.stringify(record)}::jsonb)`,
  }).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
}

// ── PR handoff ───────────────────────────────────────────────────────────────

/**
 * Pure half of `promoteLeasesToPrScope`: the manifest an open-PR task should
 * carry once its worker has ended, given what it holds. The repo-wide sentinel
 * and an absent manifest become the concrete lease set; a concrete manifest
 * gains every held path it does not already cover (exactly or as a directory).
 * Null when nothing would change.
 */
export function planPrHandoff(
  manifest: string[] | null,
  held: string[],
): { next: string[]; promoted: string[]; replacedSentinel: boolean } | null {
  const leasable = leasablePaths(held);
  if (leasable.length === 0) return null;
  const entries = (manifest ?? []).filter(p => typeof p === 'string' && p.trim().length > 0);
  const concrete = entries.filter(p => p.trim() !== REPO_WIDE_SENTINEL).map(p => stripTrailingSep(p.trim()));
  const replacedSentinel = manifest === null || concrete.length !== entries.length;
  const covered = (p: string) => concrete.some(m => m === p || p.startsWith(`${m}/`));
  const promoted = leasable.filter(p => !covered(p));
  if (promoted.length === 0 && !replacedSentinel) return null;
  return { next: [...concrete, ...promoted], promoted, replacedSentinel };
}

/**
 * The worker ended with its PR still open. Its leases are about to be released
 * (`pending_merge`), after which the only overlap surface for the open PR is
 * the claim route's layer 1 — which reads `tasks.pathManifest`. A manifest-less
 * or repo-wide task would leave the PR invisible to every later claim, so the
 * authoritative lease set is promoted into the effective manifest here, before
 * the release. Merge/close releases it with the PR (layer 1 only counts open
 * PRs), and the next push's PR-scope reconciliation narrows it to the diff.
 *
 * Returns the record written, or null when there was nothing to promote.
 */
export async function promoteLeasesToPrScope(input: {
  workspaceId: string;
  taskId: string;
  workerId: string | null;
  prNumber: number | null;
  now?: Date;
}): Promise<PrHandoffRecord | null> {
  const { workspaceId, taskId } = input;
  const held = await activeLeasePaths(workspaceId, taskId);
  if (held.length === 0) return null;

  const row = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)),
    columns: { pathManifest: true },
  });
  if (!row) return null;
  const plan = planPrHandoff(Array.isArray(row.pathManifest) ? (row.pathManifest as string[]) : null, held);
  if (!plan) return null;

  const record: PrHandoffRecord = {
    at: (input.now ?? new Date()).toISOString(),
    workerId: input.workerId,
    prNumber: input.prNumber,
    promoted: plan.promoted.length,
    replacedSentinel: plan.replacedSentinel,
  };
  await db.update(tasks).set({
    pathManifest: plan.next,
    pathDeclaration: sql`COALESCE(${tasks.pathDeclaration}, jsonb_build_object(
      'declared', ${tasks.pathManifest}, 'source', 'runtime', 'snapshotAt', now()))
      || jsonb_build_object('prHandoff', ${JSON.stringify(record)}::jsonb)`,
    pathClaimRevision: sql`${tasks.pathClaimRevision} + 1`,
  }).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
  return record;
}

/**
 * What a task owns right now, for any overlap consumer (in-flight merge/push
 * notices included): its active leases plus its effective manifest — which,
 * after a PR handoff, is the PR's own changed-file scope. Never the bounded
 * `workers.observedTouches` sample.
 */
export async function authoritativeTaskScope(workspaceId: string, taskId: string): Promise<string[]> {
  const [held, row] = await Promise.all([
    activeLeasePaths(workspaceId, taskId),
    db.query.tasks.findFirst({ where: and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)), columns: { pathManifest: true } }),
  ]);
  const manifest = Array.isArray(row?.pathManifest) ? (row!.pathManifest as string[]) : [];
  return [...new Set([...held, ...manifest.filter(p => typeof p === 'string' && p.trim() !== REPO_WIDE_SENTINEL)])].sort();
}
