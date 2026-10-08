/**
 * DB half of the live sibling conflict probe (see `sibling-conflict-probe.ts`):
 * who is live, the `sibling_probes` request/debounce rows, the instruct-queue
 * write and the `sibling_conflict_probe` gate-ledger record.
 */
import { db } from '@buildd/core/db';
import { siblingProbes, workers } from '@buildd/core/db/schema';
import { recordGateEvent, GATE_SLUGS } from '@buildd/core/gate-events';
import { TERMINAL_WORKER_STATUSES, normalizeDerivedFiles } from '@buildd/shared';
import { and, eq, gt, inArray, isNull, isNotNull, not } from 'drizzle-orm';
import { queueSystemInstruction } from '@/lib/system-instruction-queue';
import { kernelOwnedDeliveryStates } from '@/lib/workflow/delivery-view';
import { markDue } from '@/lib/redis';
import {
  SIBLING_PROBE_DUE_QUEUE,
  applySiblingProbeResult,
  readSiblingProbeResults,
  takeSiblingProbeRequests,
  type ProbeRowFull,
  type ProbeWorker,
  type SiblingProbeDeps,
} from '@/lib/sibling-conflict-probe';
import type { SiblingProbeRequest } from '@buildd/shared';

export const SIBLING_PROBE_SURFACE = 'sibling-conflict-probe';
/** A worker silent this long is not going to run a probe or read a notice. */
const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

const workerColumns = {
  id: true, taskId: true, workspaceId: true, branch: true, startedAt: true, prNumber: true, observedTouches: true,
} as const;

type WorkerRow = {
  id: string; taskId: string | null; workspaceId: string; branch: string; startedAt: Date | null; prNumber: number | null;
  observedTouches: unknown;
  task: { title: string | null; missionId: string | null; deliveryRole?: string | null } | null;
  workspace: { gitConfig: unknown; dataClass: string | null } | null;
};

/**
 * The state of the kernel-owned delivery each task owns (read through the
 * workflow module: `kernelOwnedDeliveryStates`).
 * A task with no delivery is absent from the map. A failed read marks every
 * asked task `UNKNOWN`, which `isKernelOwned` treats as kernel-owned: when we
 * cannot tell, the kernel stays the one authority (fail closed).
 */
export async function resolveKernelStates(
  taskIds: string[],
  load: (taskIds: string[]) => Promise<Array<{ ownerTaskId: string; state: string }>>,
): Promise<Map<string, string>> {
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  try {
    return new Map((await load(ids)).map(r => [r.ownerTaskId, r.state]));
  } catch (err) {
    console.error('[sibling-probe] kernel delivery read failed, treating as kernel-owned:', err);
    return new Map(ids.map(id => [id, 'UNKNOWN']));
  }
}

async function toProbeWorkers(rows: WorkerRow[]): Promise<ProbeWorker[]> {
  const states = await resolveKernelStates(rows.flatMap(r => (r.taskId ? [r.taskId] : [])), (ids) => kernelOwnedDeliveryStates(ids));
  return rows.map(r => ({ ...toProbeWorker(r), kernelState: r.taskId ? states.get(r.taskId) ?? null : null }));
}

function derivedGlobs(gitConfig: unknown): string[] {
  try {
    return normalizeDerivedFiles((gitConfig as { derivedFiles?: unknown } | null)?.derivedFiles).map(r => r.glob);
  } catch {
    return [];
  }
}

function toProbeWorker(r: WorkerRow): ProbeWorker {
  const gitConfig = (r.workspace?.gitConfig ?? null) as { mergiraf?: unknown } | null;
  return {
    workerId: r.id,
    taskId: r.taskId,
    workspaceId: r.workspaceId,
    missionId: r.task?.missionId ?? null,
    branch: r.branch,
    title: r.task?.title ?? null,
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    prNumber: r.prNumber,
    observedTouches: Array.isArray(r.observedTouches) ? (r.observedTouches as string[]) : null,
    mergiraf: gitConfig?.mergiraf === true,
    sensitive: r.workspace?.dataClass === 'sensitive',
    generatedGlobs: derivedGlobs(gitConfig),
    deliveryRole: r.task?.deliveryRole ?? null,
  };
}

const withTaskAndWorkspace = {
  task: { columns: { title: true, missionId: true, deliveryRole: true } },
  workspace: { columns: { gitConfig: true, dataClass: true } },
} as const;

function liveWhere() {
  return and(
    not(inArray(workers.status, [...TERMINAL_WORKER_STATUSES])),
    isNull(workers.mergedAt),
    gt(workers.updatedAt, new Date(Date.now() - LIVE_WINDOW_MS)),
  );
}

function toRow(r: typeof siblingProbes.$inferSelect): ProbeRowFull {
  return {
    id: r.id, pairKey: r.pairKey, workspaceId: r.workspaceId, workerAId: r.workerAId, workerBId: r.workerBId,
    proberWorkerId: r.proberWorkerId, sharedFiles: r.sharedFiles ?? [], status: r.status,
    requestedAt: r.requestedAt, dispatchedAt: r.dispatchedAt, probedAt: r.probedAt, notifiedAt: r.notifiedAt,
    notifiedHeads: r.notifiedHeads ?? null,
  };
}

export function createSiblingProbeStore(): SiblingProbeDeps {
  return {
    async loadLiveWorkers() {
      const rows = await db.query.workers.findMany({
        where: and(liveWhere(), isNotNull(workers.observedTouches)),
        columns: workerColumns,
        with: withTaskAndWorkspace,
      });
      return toProbeWorkers(rows as unknown as WorkerRow[]);
    },

    async loadProbes(pairKeys) {
      if (pairKeys.length === 0) return new Map();
      const rows = await db.select().from(siblingProbes).where(inArray(siblingProbes.pairKey, pairKeys));
      return new Map(rows.map(r => [r.pairKey, toRow(r)]));
    },

    async upsertRequest(pair, now, proberWorkerId) {
      await db.insert(siblingProbes).values({
        workspaceId: pair.workspaceId,
        pairKey: pair.pairKey,
        workerAId: pair.a.workerId,
        workerBId: pair.b.workerId,
        proberWorkerId,
        sharedFiles: pair.sharedFiles,
        status: 'requested',
        requestedAt: now,
      }).onConflictDoUpdate({
        target: [siblingProbes.workspaceId, siblingProbes.pairKey],
        set: { proberWorkerId, sharedFiles: pair.sharedFiles, status: 'requested', requestedAt: now, dispatchedAt: null },
      });
    },

    async takeRequests(workerId, now) {
      const taken = await db.update(siblingProbes)
        .set({ status: 'dispatched', dispatchedAt: now })
        .where(and(eq(siblingProbes.proberWorkerId, workerId), eq(siblingProbes.status, 'requested')))
        .returning();
      if (taken.length === 0) return [];
      const otherIds = taken.map(r => (r.workerAId === workerId ? r.workerBId : r.workerAId));
      const others = await db.query.workers.findMany({
        where: inArray(workers.id, [...new Set([...otherIds, workerId])]),
        columns: { id: true, branch: true },
        with: { workspace: { columns: { gitConfig: true } } },
      });
      const byId = new Map(others.map(o => [o.id, o]));
      const mergiraf = (byId.get(workerId) as { workspace?: { gitConfig?: { mergiraf?: unknown } | null } } | undefined)?.workspace?.gitConfig?.mergiraf === true;
      return taken.flatMap(r => {
        const other = byId.get(r.workerAId === workerId ? r.workerBId : r.workerAId);
        return other?.branch ? [{ ...toRow(r), otherBranch: other.branch, mergiraf }] : [];
      });
    },

    async loadProbe(probeId, workerId) {
      const [r] = await db.select().from(siblingProbes)
        .where(and(eq(siblingProbes.id, probeId), eq(siblingProbes.proberWorkerId, workerId)))
        .limit(1);
      return r ? toRow(r) : null;
    },

    async loadWorkers(ids) {
      const rows = await db.query.workers.findMany({
        where: inArray(workers.id, ids),
        columns: workerColumns,
        with: withTaskAndWorkspace,
      });
      return new Map((await toProbeWorkers(rows as unknown as WorkerRow[])).map(w => [w.workerId, w]));
    },

    async saveResult(probeId, fields) {
      await db.update(siblingProbes)
        .set({
          status: 'done',
          outcome: fields.outcome,
          conflictFiles: fields.conflictFiles,
          probedAt: fields.probedAt,
          ...(fields.notifiedAt ? { notifiedAt: fields.notifiedAt } : {}),
          ...(fields.notifiedHeads ? { notifiedHeads: fields.notifiedHeads } : {}),
        })
        .where(eq(siblingProbes.id, probeId));
    },

    queueInstruction(worker, text, marker) {
      return queueSystemInstruction(worker.workerId, text, { marker, sensitive: worker.sensitive });
    },

    async recordProbe(e) {
      await recordGateEvent({
        gate: GATE_SLUGS.SIBLING_CONFLICT_PROBE,
        surface: SIBLING_PROBE_SURFACE,
        outcome: e.outcome === 'conflict' || e.outcome === 'error' ? 'warned' : 'accepted',
        reason: e.outcome === 'error' ? 'probe_error' : e.outcome,
        workspaceId: e.prober.workspaceId,
        missionId: e.prober.missionId,
        taskId: e.prober.taskId,
        workerId: e.prober.workerId,
        callerOrigin: 'system',
        detail: {
          pairKey: e.pairKey,
          probeOutcome: e.outcome,
          otherWorkerId: e.other?.workerId ?? null,
          otherTaskId: e.other?.taskId ?? null,
          rebaserWorkerId: e.rebaserWorkerId,
          sharedFiles: e.sharedFiles.slice(0, 50),
          conflictFiles: e.conflictFiles.slice(0, 50),
          resolvedByMergiraf: e.resolvedByMergiraf,
          notified: e.notified,
          debounced: e.debounced,
          suppressed: e.suppressed,
          rejectedPaths: e.rejectedPaths,
          headSha: e.headSha,
          otherSha: e.otherSha,
          ...(e.error ? { error: e.error } : {}),
        },
      });
    },
  };
}

/**
 * The worker PATCH route's one call (never throws): apply the runner's probe
 * results, mark the workspace due when this heartbeat reported new touches,
 * and hand back the probes this worker's runner should run now. Only a runner
 * that declared `siblingProbe` support is handed probes, so a request is never
 * flipped to `dispatched` on a runner that cannot answer it.
 */
export async function siblingProbeHeartbeat(input: {
  workerId: string;
  workspaceId: string;
  results: unknown;
  supportsProbe: boolean;
  touchesMoved: boolean;
  terminal: boolean;
  deps?: SiblingProbeDeps;
  markDue?: (job: string, member: string, dueAtMs: number) => Promise<void>;
}): Promise<SiblingProbeRequest[]> {
  if (process.env.SIBLING_PROBE_ENABLED === '0') return [];
  try {
    const deps = input.deps ?? createSiblingProbeStore();
    for (const r of readSiblingProbeResults(input.results)) {
      await applySiblingProbeResult(input.workerId, r, deps);
    }
    if (input.touchesMoved && !input.terminal) {
      await (input.markDue ?? markDue)(SIBLING_PROBE_DUE_QUEUE, input.workspaceId, Date.now()).catch(() => {});
    }
    if (!input.supportsProbe || input.terminal) return [];
    return await takeSiblingProbeRequests(input.workerId, deps);
  } catch (err) {
    console.error(`[sibling-probe] heartbeat for worker ${input.workerId} failed:`, err);
    return [];
  }
}
