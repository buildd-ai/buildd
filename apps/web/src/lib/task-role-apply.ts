/**
 * The apply half of role routing (knowledge-base: buildd/design/role-routing.md §6(c)).
 *
 * The shadow (`task-role-decision.ts`) asks the decision model which role a
 * role-less task should have and logs the answer. When the team has also
 * listed `task_role_apply` in `teams.enabledDecisionShadows`, this module
 * writes that answer — once, and only while nothing else has touched the role:
 *
 *   UPDATE tasks SET role_slug = $slug, context = context || {roleInferred}
 *   WHERE id = $id AND role_slug IS NULL AND status = 'pending' AND claimed_at IS NULL
 *
 * No rows back is `lost_race` (claimed or edited first) and nothing else
 * happens. Below the threshold, an answer outside the candidate set, a model
 * the threshold was not measured on, or any failure leaves the role null —
 * today's behaviour. It never overwrites a role the caller stated.
 *
 * `context.roleInferred` marks the role as inferred. The claim route reads it
 * and drops the role's model from routing (`resolveClaimModelInputs`,
 * packages/core/role-model-routing.ts), so an inferred role changes who does
 * the work, never the model.
 *
 * Open decision 5 (a claim hold while the decision runs) is not taken: the
 * write races the claim, and a lost race is logged so its rate can be read.
 *
 * Every path that actually asked the model (not an upstream skip like
 * `not_enabled` or a stated role) also writes one row to the decision ledger
 * (`@buildd/core/decision-ledger`, knowledge-base: buildd/design/decision-calls.md
 * "The decision ledger") — applied, suggested-but-gated, or fallback alike.
 * This is what a weekly review reads instead of the `[decision-apply]` log line.
 */
import { EXPLICIT_ROLE_SLUGS } from '@buildd/shared';
import type { ChoiceAnswer } from '@buildd/core/decision-client';
import type { DecisionLedgerInput } from '@buildd/core/decision-ledger';
import { POLICY_DEFAULTS, policyValue } from './policy-overrides';
import {
  TASK_ROLE_CAPABILITY,
  runTaskRoleShadow,
  type TaskRoleShadowDeps,
  type TaskRoleShadowInput,
  type TaskRoleShadowResult,
} from './task-role-decision';

export const DECISION_APPLY_LOG_PREFIX = '[decision-apply]';

/**
 * The public default confidence gate. A hosted deployment replaces it with
 * the benchmarked value via the private policy record
 * (`taskRoleMinConfidencePct`); read it through `taskRoleMinConfidence()`.
 */
export const TASK_ROLE_MIN_CONFIDENCE = POLICY_DEFAULTS.taskRoleMinConfidencePct / 100;

export function taskRoleMinConfidence(): number {
  return policyValue('taskRoleMinConfidencePct') / 100;
}

/** `tasks.context.roleInferred`: what wrote the role, and on what evidence. */
export interface RoleInferredStamp {
  slug: string;
  confidence: number;
  model: string;
  /** How many roles the model chose between. */
  candidates: number;
  at: string;
}

export type ApplyOutcome =
  | 'applied'
  | 'lost_race'
  | 'not_enabled'
  | 'stated'
  | 'no_decision'
  | 'not_candidate'
  | 'unmeasured_model'
  | 'below_threshold'
  | 'error';

/** Guarded write. True when the row changed. */
export type WriteInferredRole = (taskId: string, stamp: RoleInferredStamp) => Promise<boolean>;

async function dbWriteInferredRole(taskId: string, stamp: RoleInferredStamp): Promise<boolean> {
  const { db } = await import('@buildd/core/db');
  const { tasks } = await import('@buildd/core/db/schema');
  const { and, eq, isNull, sql } = await import('drizzle-orm');
  // One atomic UPDATE … WHERE (neon-http has no interactive transactions), no read first.
  const rows = await db.update(tasks)
    .set({
      roleSlug: stamp.slug,
      context: sql`coalesce(${tasks.context}, '{}'::jsonb) || jsonb_build_object('roleInferred', ${JSON.stringify(stamp)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(tasks.id, taskId),
      isNull(tasks.roleSlug),
      eq(tasks.status, 'pending'),
      isNull(tasks.claimedAt),
    ))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

export type RecordDecisionFn = (input: DecisionLedgerInput) => Promise<void>;

async function dbRecordDecision(input: DecisionLedgerInput): Promise<void> {
  const { recordDecision } = await import('@buildd/core/decision-ledger');
  await recordDecision(input);
}

export interface ApplyDeps {
  write?: WriteInferredRole;
  minConfidence?: number;
  isMeasuredModel?: (model: string) => boolean;
  now?: () => Date;
  log?: (line: string) => void;
  recordDecision?: RecordDecisionFn;
}

/** Awaited, but a ledger write failure must never change the apply outcome. */
async function safeRecordDecision(record: RecordDecisionFn, input: DecisionLedgerInput): Promise<void> {
  try {
    await record(input);
  } catch (err) {
    console.error(`${DECISION_APPLY_LOG_PREFIX} ledger write failed (non-fatal):`, err);
  }
}

/**
 * Decide whether a shadow answer may be written, and write it. Never throws.
 * `shadow` is what `runTaskRoleShadow` returned for this task. Every branch
 * that actually asked the model also writes one decision-ledger row — not the
 * upstream skips (`not_enabled`, a stated role) where no decision was asked
 * on this task's behalf.
 */
export async function applyTaskRoleDecision(
  input: Pick<TaskRoleShadowInput, 'taskId' | 'statedRoleSlug'> & { teamId?: string; workspaceId?: string },
  shadow: TaskRoleShadowResult,
  deps: ApplyDeps = {},
): Promise<{ outcome: ApplyOutcome; stamp?: RoleInferredStamp }> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const recordFn = deps.recordDecision ?? dbRecordDecision;
  const emit = (outcome: ApplyOutcome, extra: Record<string, unknown> = {}) => {
    // Ids, slugs and numbers only.
    log(`${DECISION_APPLY_LOG_PREFIX} ${JSON.stringify({ site: 'task_role', taskId: input.taskId, outcome, ...extra })}`);
    return outcome;
  };
  const ledger = async (fingerprint: string | undefined, extra: Partial<DecisionLedgerInput>): Promise<void> => {
    if (!input.teamId || !fingerprint) return;
    await safeRecordDecision(recordFn, {
      teamId: input.teamId,
      workspaceId: input.workspaceId ?? null,
      taskId: input.taskId,
      capability: TASK_ROLE_CAPABILITY,
      fingerprint,
      ruleAnswer: null,
      appliedAnswer: null,
      applied: false,
      status: 'suggested',
      ...extra,
    });
  };
  try {
    if (!shadow.applyEnabled) return { outcome: 'not_enabled' };
    // Never overwrite a caller-supplied role, and a stated-role look is a label sample.
    if (input.statedRoleSlug || shadow.record?.stated) return { outcome: 'stated' };
    const record = shadow.record;
    if (shadow.outcome !== 'logged' || !record || !record.decision || record.confidence === null) {
      await ledger(shadow.fingerprint, { status: 'fallback', reason: shadow.outcome, promptVersion: null, model: record?.model ?? null });
      return { outcome: emit('no_decision', { shadow: shadow.outcome }) };
    }
    // Never write a slug the claim filter would reject: only a slug from the
    // candidate set the shadow built (which already excludes explicit roles).
    const slug = record.decision;
    const base: Partial<DecisionLedgerInput> = {
      promptVersion: record.v, model: record.model, verdict: slug, confidence: record.confidence,
    };
    if (!record.candidates.includes(slug) || EXPLICIT_ROLE_SLUGS.includes(slug)) {
      await ledger(record.fingerprint, { ...base, reason: 'not_candidate' });
      return { outcome: emit('not_candidate', { decision: slug }) };
    }
    // The threshold was measured on Jev. A team's own decision model is
    // logged, never applied, until it has its own eval (as task categories).
    const measured = deps.isMeasuredModel ?? (await import('@buildd/core/decision-model')).isJevModel;
    if (!measured(record.model)) {
      await ledger(record.fingerprint, { ...base, reason: 'unmeasured_model' });
      return { outcome: emit('unmeasured_model', { decision: slug, model: record.model }) };
    }

    const { gateChoice } = await import('@buildd/core/decision-client');
    const answer: ChoiceAnswer<string> = { type: 'choice', choice: slug, confidence: record.confidence, probabilities: record.probabilities ?? {} };
    const minConfidence = deps.minConfidence ?? taskRoleMinConfidence();
    const gate = gateChoice(answer, minConfidence);
    if (!gate.apply) {
      await ledger(record.fingerprint, { ...base, minConfidence, reason: 'below_threshold' });
      return { outcome: emit('below_threshold', { decision: slug, confidence: record.confidence, minConfidence }) };
    }

    const stamp: RoleInferredStamp = {
      slug,
      confidence: record.confidence,
      model: record.model,
      candidates: record.candidates.length,
      at: (deps.now?.() ?? new Date()).toISOString(),
    };
    const wrote = await (deps.write ?? dbWriteInferredRole)(input.taskId, stamp);
    const outcome = wrote ? 'applied' : 'lost_race';
    await ledger(record.fingerprint, {
      ...base, minConfidence,
      applied: wrote, status: wrote ? 'applied' : 'suggested',
      appliedAnswer: wrote ? slug : null,
      reason: wrote ? null : 'lost_race',
    });
    return { outcome: emit(outcome, { decision: slug, confidence: record.confidence, minConfidence, candidates: stamp.candidates }), stamp: wrote ? stamp : undefined };
  } catch (err) {
    console.error(`${DECISION_APPLY_LOG_PREFIX} task_role failed (non-fatal, role left unset):`, err);
    return { outcome: 'error' };
  }
}

/** The shadow look, then the apply step on its answer. Never throws. */
export async function runTaskRoleRouting(
  input: TaskRoleShadowInput,
  deps: TaskRoleShadowDeps & { apply?: ApplyDeps } = {},
): Promise<{ shadow: TaskRoleShadowResult; apply: { outcome: ApplyOutcome; stamp?: RoleInferredStamp } }> {
  const shadow = await runTaskRoleShadow(input, deps);
  const apply = await applyTaskRoleDecision(input, shadow, deps.apply);
  return { shadow, apply };
}

/**
 * Run after the response, so it can never delay or fail task creation.
 * `schedule` is `next/server`'s `after`; outside a request scope it throws, and
 * the run is fired and forgotten instead.
 */
export function scheduleTaskRoleRouting(
  input: TaskRoleShadowInput,
  schedule: (fn: () => Promise<unknown>) => void,
  deps: TaskRoleShadowDeps & { apply?: ApplyDeps } = {},
): void {
  const run = () => runTaskRoleRouting(input, deps);
  try {
    schedule(run);
  } catch {
    void run();
  }
}
