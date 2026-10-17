import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { count, eq } from 'drizzle-orm';
import {
  decideTaskIsolation,
  readIsolationRecord,
  resolveIsolationRequirement,
  taskCodexSandboxMode,
  type TaskIsolationDecision,
  type TaskIsolationStamp,
} from '@buildd/shared';

/** A team's member count, or null when it could not be read. */
export type TeamSizeLoader = (teamId: string) => Promise<number | null>;

/** Memoised per claim request; a failed read is null, which resolves to protected. */
export function teamSizeLoader(
  read: (teamId: string) => Promise<number> = async (teamId) => {
    const [row] = await db.select({ n: count() }).from(teamMembers).where(eq(teamMembers.teamId, teamId));
    return Number(row?.n ?? 0);
  },
): TeamSizeLoader {
  const cache = new Map<string, Promise<number | null>>();
  return (teamId) => {
    let hit = cache.get(teamId);
    if (!hit) {
      hit = read(teamId).catch((err) => {
        console.warn(`[claim] team size lookup failed for ${teamId} (isolation policy reads protected):`, err);
        return null;
      });
      cache.set(teamId, hit);
    }
    return hit;
  };
}

export interface IsolationGateTask {
  kind?: string | null;
  backend?: string | null;
  context?: unknown;
  workspace?: { teamId?: string | null; accessMode?: string | null; gitConfig?: unknown } | null;
}

/**
 * The claim's isolation gate (Living Spec "Runner isolation", R-4, R-5):
 * resolve the task's requirement from policy and decide it against the
 * isolation record the claiming runner sent with this claim (its state as of
 * this request). The backend must be final: call after failover and toggles.
 *
 * `stamp` is set when the task may run; the route writes it to the task
 * context so the runner applies the same rule to its own session.
 */
export async function decideClaimIsolation(input: {
  task: IsolationGateTask;
  environment: unknown;
  teamSize: TeamSizeLoader;
}): Promise<{ decision: TaskIsolationDecision; stamp: TaskIsolationStamp | null }> {
  const { task } = input;
  const teamId = task.workspace?.teamId ?? null;
  const policy = (task.workspace?.gitConfig as { isolationPolicy?: unknown } | null | undefined)?.isolationPolicy;
  const resolved = resolveIsolationRequirement({
    workspacePolicy: policy,
    workspaceAccessMode: task.workspace?.accessMode ?? null,
    // Only needed when the workspace sets no policy.
    teamMemberCount: policy === undefined && teamId ? await input.teamSize(teamId) : null,
  });
  const decision = decideTaskIsolation({
    requirement: resolved.requirement,
    record: readIsolationRecord(input.environment),
    backend: task.backend === 'codex' ? 'codex' : 'claude',
    codexMode: taskCodexSandboxMode(task.kind, task.context),
  });
  return {
    decision,
    stamp: decision.ok ? { requirement: resolved.requirement, source: resolved.source, mode: decision.mode } : null,
  };
}
