/**
 * Shared preflight gate and orchestration for the two manual update
 * endpoints (`/api/update` and `/api/update/apply`).
 *
 * Kept dependency-free / dependency-injected on purpose: `index.ts` cannot be
 * imported by a test (it has top-level side effects — env var checks,
 * `process.exit` calls — that run at module load), so any logic that needs
 * unit coverage has to live somewhere importable. Every side effect here is a
 * parameter rather than a closure over runner state, mirroring the `fsOps`
 * seam `applyUpdate` already uses in updater.ts.
 */

import type { UpdateResult } from './updater';

export interface ManualUpdateGateWorker {
  status: string;
}

export interface ManualUpdateGateInput {
  /** Only a loopback socket peer may trigger an update — see isLoopbackAddress. */
  isLocalPeer: boolean;
  updating: boolean;
  workers: ManualUpdateGateWorker[];
  treeClean: boolean;
}

export type ManualUpdateGateResult =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

const ACTIVE_WORKER_STATUSES = new Set(['working', 'waiting', 'stale']);

/**
 * Pure preflight for a manual update request. Order matches the checks
 * `/api/update` already enforced: a non-local caller is refused before
 * anything else is even evaluated, then in-flight state, then active work,
 * then tree cleanliness. `/api/update/apply` previously only checked
 * `updating`, which is exactly the gap this closes.
 */
export function evaluateManualUpdateGate(input: ManualUpdateGateInput): ManualUpdateGateResult {
  if (!input.isLocalPeer) {
    return { ok: false, status: 403, body: { error: 'Update can only be triggered from localhost' } };
  }
  if (input.updating) {
    return { ok: false, status: 409, body: { error: 'Update already in progress' } };
  }
  const activeWorkers = input.workers.filter((w) => ACTIVE_WORKER_STATUSES.has(w.status));
  if (activeWorkers.length > 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'Cannot update while tasks are running',
        activeWorkers: activeWorkers.length,
        hint: 'Wait for active tasks to complete or stop them first',
      },
    };
  }
  if (!input.treeClean) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'Working tree has uncommitted changes',
        hint: 'Commit or stash changes in ~/.buildd before updating',
      },
    };
  }
  return { ok: true };
}

export interface ManualUpdateDeps {
  clearSkippedTargets: () => void;
  setUpdating: (on: boolean) => void;
  broadcast: (event: { type: string; [key: string]: unknown }) => void;
  applyUpdate: () => Promise<UpdateResult>;
  rollbackTo: (targetCommit: string) => Promise<UpdateResult>;
  runHealthProbe: () => Promise<{ ok: boolean; detail: string }>;
  scheduleGracefulRestart: (reason: string) => void;
  abandonUpdateTarget: (sha: string | null) => void;
  getLatestCommit: () => string | null;
  isNoProgressUpdate: (previousCommit: string | null, newCommit: string | null) => boolean;
}

export interface ManualUpdateOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The gated body of a manual update, shared by both endpoints so they cannot
 * diverge again: clean reinstall -> no-progress guard -> health probe ->
 * restart. A failed reinstall, a no-op reset, or a failed health check all
 * end the same way — `updating` cleared, nothing restarted — and a failed
 * health check additionally rolls back to the pre-update commit. The caller
 * is responsible for running `evaluateManualUpdateGate` first; this function
 * assumes the gate already passed.
 */
export async function performManualUpdate(
  reason: string,
  deps: ManualUpdateDeps,
): Promise<ManualUpdateOutcome> {
  deps.clearSkippedTargets();
  deps.setUpdating(true);
  deps.broadcast({ type: 'update_started' });

  const result = await deps.applyUpdate();

  if (!result.success) {
    deps.setUpdating(false);
    deps.broadcast({ type: 'update_failed', error: result.error });
    return { status: 500, body: { success: false, error: result.error } };
  }

  const previousCommit = result.previousCommit ?? null;
  const newCommit = result.newCommit ?? null;

  if (deps.isNoProgressUpdate(previousCommit, newCommit)) {
    // A reset that changed nothing is not a success — restarting on it is the
    // unbounded loop isNoProgressUpdate exists to prevent.
    const detail = `the reset did not move HEAD (still ${newCommit?.slice(0, 7) ?? 'unknown'})`;
    deps.abandonUpdateTarget(deps.getLatestCommit());
    deps.setUpdating(false);
    deps.broadcast({ type: 'update_failed', error: `no progress — ${detail}` });
    return { status: 409, body: { success: false, error: `Update made no progress — ${detail}` } };
  }

  const health = await deps.runHealthProbe();
  if (!health.ok) {
    if (previousCommit) {
      await deps.rollbackTo(previousCommit);
    }
    deps.setUpdating(false);
    deps.broadcast({
      type: 'update_failed',
      error: `New version failed health check — rolled back: ${health.detail}`,
    });
    return {
      status: 500,
      body: {
        success: false,
        error: 'Update rolled back — new version failed health check',
        detail: health.detail,
        rolledBackTo: previousCommit?.slice(0, 7),
      },
    };
  }

  deps.broadcast({ type: 'update_complete', newCommit: newCommit?.slice(0, 7) });
  deps.scheduleGracefulRestart(reason);
  return {
    status: 200,
    body: { success: true, newCommit: newCommit?.slice(0, 7), previousCommit: previousCommit?.slice(0, 7) },
  };
}
