/**
 * Report coding outcomes to the model policy service, against the decision a
 * claim stored on the task (`context.resolvedTier.policy`, see
 * packages/core/model-policy.ts).
 *
 * Only trustworthy coding signals buildd already has, each as its own typed
 * observation (no score): CI on the task's PR (`tests`), the reviewer verdict
 * (`review_verdict`, `rework`), the merge (`merged`), and the run's duration
 * and cost. Chat reports nothing yet: buildd has no chat signal it trusts
 * enough to key to a decision.
 *
 * A no-op, with no DB read, unless a policy service is configured; and a no-op
 * for a task whose decision no service issued (no planId). Never throws.
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  remotePolicyConfigFromEnv, reportPolicyOutcome, type RemotePolicyConfig,
} from '@buildd/core/model-policy';
import type { PolicyObservation } from '@builddai/ai-kit/policy';

export interface ReportTaskPolicyOutcomeDeps {
  configured: () => RemotePolicyConfig | null;
  loadContext: (taskId: string) => Promise<unknown>;
  report: typeof reportPolicyOutcome;
}

const defaultDeps: ReportTaskPolicyOutcomeDeps = {
  configured: () => remotePolicyConfigFromEnv(),
  loadContext: async (taskId) => {
    const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { context: true } });
    return row?.context ?? null;
  },
  report: reportPolicyOutcome,
};

export async function reportTaskPolicyOutcome(
  taskId: string | null | undefined,
  observations: PolicyObservation[],
  deps: ReportTaskPolicyOutcomeDeps = defaultDeps,
): Promise<boolean> {
  if (!taskId || observations.length === 0 || !deps.configured()) return false;
  try {
    const context = await deps.loadContext(taskId);
    const r = await deps.report(context, observations);
    if (r.error) console.warn(`[model-policy] outcome for task ${taskId} not reported: ${r.error}`);
    return r.reported;
  } catch (err) {
    console.warn(`[model-policy] outcome for task ${taskId} failed:`, err);
    return false;
  }
}
