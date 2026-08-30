/**
 * Which agent backends are currently stranding work, and how much.
 *
 * A pending task whose effective backend has no usable credential can never be
 * claimed by any runner: the claim route either drops it from the candidate set
 * (the Codex capability filter) or defers it forever (`provider_unavailable`).
 * There is deliberately NO task-level gate for this — the capability abstraction
 * whose only real check was "does this backend have a credential" was removed in
 * PR #1864 and replaced by configuration-time surfacing (see `docs/SPEC.md` →
 * Removed concepts). This module is that surfacing: it turns "Codex: not
 * configured" into "Codex: not configured — 7 pending tasks can never be
 * claimed", for the settings page, the Health problem list, and the queue-stall
 * watchdog.
 *
 * It is a reporting module. Nothing here withholds a task from anything.
 *
 * ── Effective backend ───────────────────────────────────────────────────────
 * `resolveEffectiveBackend` (@buildd/core/backend-policy) is the single shared
 * answer to "where will this task actually run": `tasks.backend` already holds
 * the resolved mission → role → workspace chain (resolution happens once, at
 * creation), and the team's enabled-provider mask is applied over it exactly as
 * the claim route does at dispatch. Two consequences that matter:
 *   - a task nominally on a DISABLED backend is not stranded — the mask
 *     reroutes it to an enabled one;
 *   - a task on an ENABLED backend can be stranded even though its stored
 *     backend is fine, when the mask redirects it onto an unconfigured one.
 *
 * ── Claude is never the problem ─────────────────────────────────────────────
 * Claude is `implicitlyConfigured` (it runs on the caller's own auth), so the
 * common case reports nothing and no operator sees a scary count for a healthy
 * fleet. Claude only appears here if it is disabled team-wide, in which case its
 * work has been masked onto another backend anyway.
 */

import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  BACKEND_REGISTRY,
  DISPATCHABLE_BACKENDS,
  isBackendEnabled,
  isDispatchableBackend,
  resolveEffectiveBackend,
  type AgentBackend,
} from '@buildd/core/backend-policy';
import { isBackendConfigured, teamEnabledBackends } from './backend-failover';

/** Named tasks shown alongside the count, so the operator can click through. */
export interface StrandedTaskSample {
  id: string;
  title: string;
  workspaceName: string | null;
}

export interface BackendStrandStat {
  backend: AgentBackend;
  /** Operator-facing name, from the backend registry. */
  label: string;
  /**
   * A credential usable team-wide is present (or none is needed). A credential
   * scoped to one workspace leaves this false — it does not make the backend
   * usable for the team, and `strandedPending` will show which work it misses.
   */
  configured: boolean;
  /** The team's provider mask allows this backend to be dispatched. */
  enabledForTeam: boolean;
  /** The mask redirects some other backend's work onto this one. */
  receivesMaskedWork: boolean;
  /** Pending tasks whose effective backend is this one, with no credential for it. */
  strandedPending: number;
  sampleTasks: StrandedTaskSample[];
}

export interface BackendStrandSummary {
  backends: BackendStrandStat[];
  totalStranded: number;
}

const DEFAULT_SAMPLE_LIMIT = 5;

/**
 * Per-backend stranding for one team.
 *
 * Two queries regardless of queue size: an exact `GROUP BY (workspace, backend)`
 * rollup (so the count is never a silently truncated page of rows), then one
 * sample query per backend that is actually stranding work. A healthy team pays
 * for the rollup only.
 */
export async function getBackendStrandSummary(opts: {
  teamId: string;
  /** The team's workspace ids — the caller usually has these already. */
  workspaceIds: string[];
  sampleLimit?: number;
}): Promise<BackendStrandSummary> {
  const sampleLimit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const enabled = await teamEnabledBackends(opts.teamId);

  const base = async (): Promise<BackendStrandStat[]> =>
    Promise.all(
      DISPATCHABLE_BACKENDS.map(async (backend) => ({
        backend,
        label: BACKEND_REGISTRY[backend].label,
        configured: await safeConfigured(backend, { teamId: opts.teamId }),
        enabledForTeam: isBackendEnabled(backend, enabled),
        receivesMaskedWork: DISPATCHABLE_BACKENDS.some(
          (other) => other !== backend && resolveEffectiveBackend(other, enabled) === backend,
        ),
        strandedPending: 0,
        sampleTasks: [] as StrandedTaskSample[],
      })),
    );

  const stats = await base();
  const byBackend = new Map(stats.map((s) => [s.backend, s]));

  if (opts.workspaceIds.length === 0) {
    return { backends: stats, totalStranded: 0 };
  }

  const rollup = (await db
    .select({
      workspaceId: tasks.workspaceId,
      backend: tasks.backend,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(and(eq(tasks.status, 'pending'), inArray(tasks.workspaceId, opts.workspaceIds)))
    .groupBy(tasks.workspaceId, tasks.backend)) as unknown as Array<{
    workspaceId: string;
    backend: string | null;
    count: number;
  }>;

  // Stored backends that map onto each stranded effective backend, plus the
  // workspaces where that effective backend has no credential. The mask is
  // team-wide, so the stored → effective mapping is uniform across workspaces
  // and only the credential lookup has to be per-workspace.
  const strandedStored = new Map<AgentBackend, Set<AgentBackend>>();
  const strandedWorkspaces = new Map<AgentBackend, Set<string>>();

  for (const row of rollup) {
    const effective = resolveEffectiveBackend(row.backend, enabled);
    if (await safeConfigured(effective, { teamId: opts.teamId, workspaceId: row.workspaceId })) continue;
    const stat = byBackend.get(effective);
    if (!stat) continue;
    stat.strandedPending += row.count;
    if (!strandedStored.has(effective)) strandedStored.set(effective, new Set());
    if (!strandedWorkspaces.has(effective)) strandedWorkspaces.set(effective, new Set());
    strandedStored.get(effective)!.add(isDispatchableBackend(row.backend) ? row.backend : 'claude');
    strandedWorkspaces.get(effective)!.add(row.workspaceId);
  }

  if (sampleLimit > 0) {
    for (const [effective, stored] of strandedStored) {
      const wsIds = [...(strandedWorkspaces.get(effective) ?? [])];
      const sampleRows = (await db
        .select({ id: tasks.id, title: tasks.title, workspaceName: workspaces.name })
        .from(tasks)
        .leftJoin(workspaces, eq(tasks.workspaceId, workspaces.id))
        .where(
          and(
            eq(tasks.status, 'pending'),
            inArray(tasks.workspaceId, wsIds),
            inArray(tasks.backend, [...stored]),
          ),
        )
        .orderBy(asc(tasks.createdAt))
        .limit(sampleLimit)) as unknown as StrandedTaskSample[];
      const stat = byBackend.get(effective);
      if (stat) stat.sampleTasks = sampleRows;
    }
  }

  return {
    backends: stats,
    totalStranded: stats.reduce((sum, s) => sum + s.strandedPending, 0),
  };
}

/**
 * A per-task probe with memoized mask/credential lookups, for callers that walk
 * a task list (the queue-stall watchdog) rather than counting a whole team.
 *
 * Fail-open: a lookup that throws returns "not stranded". A reporting path that
 * invents a permanent block out of a transient DB error is worse than silence.
 */
export function createBackendStrandProbe() {
  const maskCache = new Map<string, Promise<AgentBackend[] | null>>();
  const credCache = new Map<string, Promise<boolean>>();

  return {
    async check(task: {
      backend: string | null | undefined;
      workspaceId: string;
      teamId: string | null | undefined;
    }): Promise<{ backend: AgentBackend; label: string } | null> {
      // Without a team there is no credential scope to check against — every
      // secret is team-scoped at minimum.
      if (!task.teamId) return null;

      let enabled: AgentBackend[] | null;
      try {
        if (!maskCache.has(task.teamId)) maskCache.set(task.teamId, teamEnabledBackends(task.teamId));
        enabled = await maskCache.get(task.teamId)!;
      } catch {
        return null;
      }

      const effective = resolveEffectiveBackend(task.backend, enabled);
      if (BACKEND_REGISTRY[effective].implicitlyConfigured) return null;

      const key = `${effective}:${task.teamId}:${task.workspaceId}`;
      let configured: boolean;
      try {
        if (!credCache.has(key)) {
          credCache.set(
            key,
            isBackendConfigured(effective, {
            teamId: task.teamId,
            workspaceId: task.workspaceId,
            anyAccount: true,
          }),
          );
        }
        configured = await credCache.get(key)!;
      } catch {
        return null;
      }

      if (configured) return null;
      return { backend: effective, label: BACKEND_REGISTRY[effective].label };
    },
  };
}

/** isBackendConfigured, but a thrown lookup reads as "configured" (fail-open). */
async function safeConfigured(
  backend: AgentBackend,
  scope: { teamId: string; workspaceId?: string },
): Promise<boolean> {
  try {
    // anyAccount: this is a fleet question, not a per-runner one — a credential
    // scoped to one runner account still means the backend can run.
    return await isBackendConfigured(backend, { ...scope, anyAccount: true });
  } catch {
    return true;
  }
}
