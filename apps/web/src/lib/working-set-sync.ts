/**
 * Worker PATCH ↔ authoritative working set (docs/specs/path-claim-ownership.md).
 *
 * The app-layer glue between `PATCH /api/workers/[id]` and the core
 * reconciliation (`@buildd/core/path-claim` → working-set.ts): parse the
 * runner's delta, apply it, deliver the waiters a removal woke, record the
 * bounded proof on the task, and put the right rows on the gate ledger with the
 * right signal — so a sentinel reading the ledger sees "blocked by a live
 * holder" and "coverage unknown at ship" as the different things they are.
 *
 * Also owns the bounded observed-touch SAMPLE (`workers.observedTouches`):
 * what the dashboard shows, never what coordination is decided on. Hitting its
 * cap is an `observation_truncated` advisory, fired once per worker, not a
 * degradation of anything.
 */
import type { PathCollisionNotice, ShipCheckpointReport, WorkingSetAck, WorkingSetDelta } from '@buildd/shared';
import { WORKING_SET_CHUNK, WORKING_SET_HELD_CAP } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import {
  reconcileWorkingSet,
  recordWorkingSet,
  workingSetRecord,
  promoteLeasesToPrScope,
  activeLeasePaths,
} from '@buildd/core/path-claim';
import { PATH_SIGNAL_REASONS } from '@buildd/core/gate-analytics';
import { deliverPathReleased } from '@/lib/path-claim-release';
import { recordPathDeclaration } from '@/lib/path-declaration-ledger';
import { fireGateEvent, fireRepeatGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';

export const WORKER_PATCH_SURFACE = 'PATCH /api/workers/[id]';

/** `workers.observedTouches` keeps at most this many paths. A sample, not the set. */
export const OBSERVED_TOUCHES_CAP = 500;

// ── Parsing ──────────────────────────────────────────────────────────────────

const strings = (v: unknown, cap: number): string[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out = v.filter((p): p is string => typeof p === 'string');
  return out.length > cap ? null : out;
};

/**
 * A well-formed delta or null. Each side is bounded (a runner never sends
 * more than a chunk; a bad client cannot make one request O(repo)). Null is
 * "ignore this field", never an error on the progress report.
 */
export function parseWorkingSetDelta(raw: unknown): WorkingSetDelta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const generation = typeof r.generation === 'number' && Number.isFinite(r.generation) && r.generation >= 0 ? r.generation : null;
  if (generation === null) return null;
  const add = strings(r.add, WORKING_SET_CHUNK * 2);
  const remove = strings(r.remove, WORKING_SET_CHUNK * 2);
  if (!add || !remove) return null;
  const checkpoint = r.checkpoint === 'pre_push' || r.checkpoint === 'completion' ? r.checkpoint : undefined;
  return {
    generation,
    add,
    remove,
    complete: r.complete === true,
    ...(checkpoint ? { checkpoint } : {}),
    ...(r.includeHeld === true ? { includeHeld: true } : {}),
  };
}

export function parseShipCheckpointReports(raw: unknown): ShipCheckpointReport[] {
  if (!Array.isArray(raw)) return [];
  const out: ShipCheckpointReport[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const source = r.source === 'pre_push' || r.source === 'completion' ? r.source : null;
    const cause = r.cause === 'timeout' || r.cause === 'error' || r.cause === 'sweep_incomplete' || r.cause === 'server_rejected' ? r.cause : null;
    if (!source || !cause || r.result !== 'unknown') continue;
    out.push({
      source, cause, result: 'unknown',
      refused: r.refused === true,
      attempts: typeof r.attempts === 'number' && Number.isFinite(r.attempts) ? Math.max(0, Math.floor(r.attempts)) : 0,
      at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : Date.now(),
    });
  }
  return out;
}

// ── Observed sample ──────────────────────────────────────────────────────────

export interface ObservedSampleUpdate {
  sample: string[];
  /** This update is the one that crossed the cap (fire the advisory once). */
  crossedCap: boolean;
  /** Incoming paths that did not fit. They are leased all the same. */
  dropped: number;
}

/** Dedup-append `incoming` onto the stored sample, bounded at `cap`. Pure. */
export function boundedObservedSample(existing: unknown, incoming: readonly string[], cap = OBSERVED_TOUCHES_CAP): ObservedSampleUpdate {
  const base = Array.isArray(existing) ? existing.filter((p): p is string => typeof p === 'string') : [];
  const merged = [...base];
  const seen = new Set(base);
  for (const p of incoming) {
    if (typeof p !== 'string' || seen.has(p)) continue;
    seen.add(p);
    merged.push(p);
  }
  const sample = merged.length > cap ? merged.slice(0, cap) : merged;
  return {
    sample,
    // Fired once: the sample was still under the cap before this update.
    crossedCap: base.length < cap && merged.length > cap,
    dropped: Math.max(0, merged.length - cap),
  };
}

// ── Applying a delta ─────────────────────────────────────────────────────────

export interface ApplyWorkingSetInput {
  worker: { id: string; workspaceId: string; taskId: string };
  delta: WorkingSetDelta;
  /** A read-only reviewer never leases. */
  readOnly: boolean;
}

export interface ApplyWorkingSetOutput {
  ack: WorkingSetAck;
  /** For the legacy `pathCollisions` response field. */
  collisions: PathCollisionNotice[];
}

/**
 * Apply one delta for a live worker. Never throws into the PATCH: a failure
 * here returns an ACK that applied nothing (coverage `partial`) so the runner
 * re-offers rather than assumes held — the lease is the contract, the
 * progress report must still land.
 */
export async function applyWorkingSetSync(input: ApplyWorkingSetInput): Promise<ApplyWorkingSetOutput> {
  const { worker, delta } = input;
  const unapplied: WorkingSetAck = {
    generation: delta.generation, acquired: [], blocked: [], released: [], heldCount: 0, applied: false, coverage: 'partial',
  };
  let result: Awaited<ReturnType<typeof reconcileWorkingSet>>;
  try {
    result = await reconcileWorkingSet({
      workspaceId: worker.workspaceId, taskId: worker.taskId, delta, readOnly: input.readOnly,
    });
  } catch (err) {
    console.error(`[working-set] reconcile failed for worker ${worker.id}:`, err);
    return { ack: unapplied, collisions: [] };
  }

  if (result.release) {
    await deliverPathReleased(worker.taskId, result.release, 'narrowed');
  }

  // Holder titles for the collision notice (best effort).
  let collisions: PathCollisionNotice[] = result.ack.blocked;
  if (result.blocked.length > 0) {
    const holderIds = [...new Set(result.blocked.map(b => b.blockingTaskId))];
    const holders = await db.query.tasks.findMany({
      where: inArray(tasks.id, holderIds),
      columns: { id: true, title: true },
    }).catch(() => [] as Array<{ id: string; title: string | null }>);
    const titles = new Map((holders ?? []).map(h => [h.id, h.title ?? null]));
    collisions = result.blocked.map(b => ({
      path: b.path, blockingTaskId: b.blockingTaskId, blockingTaskTitle: titles.get(b.blockingTaskId) ?? null, blockingPath: b.blockingPath,
    }));
  }
  const ack: WorkingSetAck = { ...result.ack, blocked: collisions };

  if (ack.acquired.length > 0) {
    console.log(`[path-claim] working set: worker ${worker.id} holds ${ack.acquired.length} more path(s) for task ${worker.taskId} (${ack.heldCount} total, gen ${delta.generation})`);
  }

  // Declaration denominators (conflict-aware-orchestration.md §3), with the
  // size/latency buckets that decide whether exact leases ever need compressing.
  recordPathDeclaration({
    result: collisions.length > 0 ? 'denied' : 'succeeded',
    provenance: 'observed',
    surface: WORKER_PATCH_SURFACE,
    workspaceId: worker.workspaceId, taskId: worker.taskId, workerId: worker.id, callerOrigin: 'worker',
    pathCount: delta.add.length + delta.remove.length,
    detail: {
      leased: ack.acquired.length, blocked: collisions.length, released: ack.released.length,
      sizeBucket: result.sizeBucket, latencyMs: result.latencyMs,
      generation: delta.generation, complete: delta.complete, checkpoint: delta.checkpoint ?? null,
      ...(collisions.length > 0 ? { signal: 'claim_blocked' } : {}),
    },
  });

  // The bounded proof, written when it is worth reading: a checkpoint, a
  // completed sync, or a block. Never on every partial chunk of a big set.
  if (delta.checkpoint || delta.complete || collisions.length > 0) {
    try {
      await recordWorkingSet(worker.workspaceId, worker.taskId, workingSetRecord({ ack, checkpoint: delta.checkpoint, workerId: worker.id }));
    } catch (err) {
      console.warn(`[working-set] could not record the proof on task ${worker.taskId}:`, err);
    }
  }

  return { ack, collisions };
}

// ── Ledger rows ──────────────────────────────────────────────────────────────

/** The one-per-worker advisory that the observed SAMPLE is truncated. */
export function fireObservationTruncated(worker: { id: string; workspaceId: string | null; taskId: string | null }, update: ObservedSampleUpdate): void {
  fireGateEvent({
    gate: GATE_SLUGS.PATH_CLAIM,
    surface: WORKER_PATCH_SURFACE,
    outcome: 'warned',
    reason: PATH_SIGNAL_REASONS.observation_truncated,
    workspaceId: worker.workspaceId,
    taskId: worker.taskId,
    workerId: worker.id,
    callerOrigin: 'worker',
    detail: { signal: 'observation_truncated', cap: OBSERVED_TOUCHES_CAP, dropped: update.dropped },
  });
}

/**
 * Ship checkpoints the runner could not prove. Refused (enforce) is a
 * deferral — the ship did not happen; let through (advisory) is a warning.
 * Repeats for one worker and cause inside ten minutes coalesce into one row.
 */
export function recordShipCheckpointReports(
  worker: { id: string; workspaceId: string | null; taskId: string | null },
  reports: ShipCheckpointReport[],
): void {
  for (const r of reports) {
    fireRepeatGateEvent({
      gate: GATE_SLUGS.PATH_CLAIM,
      surface: WORKER_PATCH_SURFACE,
      outcome: r.refused ? 'deferred' : 'warned',
      reason: r.refused ? PATH_SIGNAL_REASONS.coverage_unknown_refused : PATH_SIGNAL_REASONS.coverage_unknown_advisory,
      workspaceId: worker.workspaceId,
      taskId: worker.taskId,
      workerId: worker.id,
      callerOrigin: 'worker',
      detail: { signal: 'coverage_unknown_at_ship', source: r.source, cause: r.cause, refused: r.refused, attempts: r.attempts, at: new Date(r.at).toISOString() },
    }, { key: { workerId: worker.id, cause: r.cause, refused: String(r.refused) }, windowMs: 10 * 60 * 1000 });
  }
}

// ── Terminal transitions ─────────────────────────────────────────────────────

/**
 * The worker ended with its PR still open: promote what it holds into the
 * open-PR overlap surface before the terminal release. Never throws.
 */
export async function handoffPrScope(input: { workspaceId: string; taskId: string; workerId: string; prNumber: number | null }): Promise<void> {
  try {
    const rec = await promoteLeasesToPrScope(input);
    if (rec) console.log(`[path-claim] PR handoff: task ${input.taskId} keeps ${rec.promoted} lease path(s) on its open PR scope${rec.replacedSentinel ? ' (manifest was undeclared)' : ''}`);
  } catch (err) {
    console.error(`[path-claim] PR handoff failed for task ${input.taskId}:`, err);
  }
}

/** What the task holds at terminal time, for the final touched-file label. Empty on failure. */
export async function terminalOwnedPaths(workspaceId: string, taskId: string): Promise<string[]> {
  try {
    return (await activeLeasePaths(workspaceId, taskId)).slice(0, WORKING_SET_HELD_CAP);
  } catch {
    return [];
  }
}
