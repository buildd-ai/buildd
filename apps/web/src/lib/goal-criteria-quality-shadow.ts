/**
 * Runs the `mission_goal_quality` verdict (lib/goal-criteria-quality-decision.ts)
 * for a goal-criteria write that POST /api/missions or PATCH
 * /api/missions/[id] has already committed.
 *
 * Always after the response: `after()` when a request scope exists, else an
 * unawaited promise. So it can never slow or fail the write, and in `shadow`
 * mode nothing it finds reaches the response. Weak criteria are recorded as
 * `warned` rows in the gate ledger.
 *
 * The workspace's `dataClass` is read here, in the background, when the route
 * did not already have it, and that read fails CLOSED: if we cannot tell
 * whether a workspace is sensitive, nothing is sent.
 */
import { after } from 'next/server';
import type { GoalCriterion } from '@buildd/shared';
import type { GateCallerOrigin, RecordGateEventInput } from '@buildd/core/gate-events';
import {
  GOAL_QUALITY_MODE,
  adviseGoalQuality,
  goalQualityWarnings,
  type GoalQualityDeps,
  type GoalQualityVerdict,
} from './goal-criteria-quality-decision';

export interface GoalQualityShadowInput {
  missionId: string;
  teamId: string;
  workspaceId: string | null;
  /** The validated, committed `goalCriteria`. */
  criteria: unknown;
  /** PATCH: the criteria stored before the write. */
  stored?: unknown;
  /** The workspace's data class when the caller already has it; `undefined` ⇒ read it in the background. */
  dataClass?: string | null;
  accountId?: string | null;
  userId?: string | null;
  surface: 'POST /api/missions' | 'PATCH /api/missions/[id]';
  callerOrigin?: GateCallerOrigin | null;
}

type Schedule = (fn: () => Promise<unknown>) => void;

export interface GoalQualityShadowOpts {
  schedule?: Schedule;
  deps?: GoalQualityDeps;
  fire?: (input: RecordGateEventInput) => void;
  loadDataClass?: (workspaceId: string) => Promise<string | null>;
}

async function defaultLoadDataClass(workspaceId: string): Promise<string | null> {
  const [{ db }, { workspaces }, { eq }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
  ]);
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { dataClass: true, gitConfig: true } });
  // Either marker makes it sensitive: the column most routes read, or the
  // gitConfig field the spec names (and task creation still reads).
  const legacy = (ws?.gitConfig as { dataClass?: string | null } | null)?.dataClass;
  return ws?.dataClass === 'sensitive' || legacy === 'sensitive' ? 'sensitive' : ws?.dataClass ?? null;
}

async function defaultFire(input: RecordGateEventInput): Promise<void> {
  const { fireGateEvent } = await import('./gate-ledger');
  fireGateEvent(input);
}

/** The work itself. Never throws; null when there is no verdict. */
export async function runGoalQualityShadow(input: GoalQualityShadowInput, opts: GoalQualityShadowOpts = {}): Promise<GoalQualityVerdict | null> {
  try {
    if (!Array.isArray(input.criteria) || input.criteria.length === 0) return null;
    let dataClass = input.dataClass;
    if (dataClass === undefined) {
      if (!input.workspaceId) dataClass = null;
      else {
        try {
          dataClass = await (opts.loadDataClass ?? defaultLoadDataClass)(input.workspaceId);
        } catch {
          dataClass = 'sensitive';
        }
      }
    }
    const verdict = await adviseGoalQuality({
      missionId: input.missionId,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      userId: input.userId ?? null,
      dataClass,
      criteria: input.criteria as GoalCriterion[],
      stored: input.stored,
    }, opts.deps);
    if (!verdict) return null;
    const rows = goalQualityWarnings(verdict, {
      missionId: input.missionId,
      workspaceId: input.workspaceId,
      surface: input.surface,
      callerOrigin: input.callerOrigin ?? null,
      mode: GOAL_QUALITY_MODE,
    });
    for (const row of rows) {
      try {
        if (opts.fire) opts.fire(row);
        else void defaultFire(row).catch(() => {});
      } catch {
        // The ledger is observability; it never fails anything.
      }
    }
    return verdict;
  } catch (err) {
    console.error('[decision-shadow] goal_criteria_quality shadow failed (non-fatal):', err);
    return null;
  }
}

/**
 * Schedule the verdict after the response. Returns immediately and never
 * throws; the response the route sends is exactly what it would send without
 * this call.
 */
export function scheduleGoalQualityShadow(input: GoalQualityShadowInput, opts: GoalQualityShadowOpts = {}): void {
  const run = () => runGoalQualityShadow(input, opts);
  try {
    (opts.schedule ?? after)(run);
  } catch {
    // after() is unavailable outside a request scope (tests, scripts).
    void run().catch(() => {});
  }
}
