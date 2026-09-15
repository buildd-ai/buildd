/**
 * The gate ledger writer.
 *
 * ONE helper for every server-side refusal, deferral, advisory warning and
 * explicit bypass. See `packages/core/db/schema.ts` → `gateEvents` for why this
 * exists at all, and `docs/reports/gate-audit.md` for the sites it is wired
 * into.
 *
 * Two properties are load-bearing:
 *
 * 1. **It never throws into the request path.** A gate's behaviour must not
 *    depend on whether its ledger row landed. `recordGateEvent` returns a
 *    promise that always resolves, and every call site fires it without
 *    awaiting. An observability table that can 500 a task creation is strictly
 *    worse than no table.
 *
 * 2. **`reason` goes through `normalizeErrorSignature`.** The same normalizer
 *    `get_failure_analytics` clusters worker errors with, so a refusal whose
 *    message embeds a branch name, a task id or a count collapses into one
 *    row instead of one row per occurrence — the exact failure mode that made
 *    four identical create_pr rejections look like four unrelated events.
 */
import { eq, desc } from 'drizzle-orm';
import { db } from './db/client';
import { gateEvents } from './db/schema';
import { normalizeErrorSignature } from './error-signature';

/** What the gate decided. */
export type GateOutcome = 'rejected' | 'deferred' | 'bypassed' | 'warned' | 'stranded';

/** Which door the call came in. */
export type GateCallerOrigin = 'api' | 'dashboard' | 'worker' | 'system';

export const GATE_OUTCOMES: readonly GateOutcome[] = ['rejected', 'deferred', 'bypassed', 'warned', 'stranded'];

/**
 * The gate vocabulary.
 *
 * A slug names the RULE, not the message. Renaming one forks its own history —
 * old rows keep the old slug and the aggregation reports two gates where there
 * is one — so add here rather than editing in place, and treat a rename as a
 * data migration.
 */
export const GATE_SLUGS = {
  /** POST /api/tasks — out-of-vocabulary `kind` / `complexity`. */
  TASK_PARAM_VOCABULARY: 'task_param_vocabulary',
  /** POST /api/tasks — advisory prose dependency-gate lint. */
  PROSE_GATE: 'prose_gate',
  /** POST /api/tasks — `[friction]` filing folded into an open task. */
  FRICTION_DEDUPE: 'friction_dedupe',
  /** POST /api/tasks — subject-anchor attach, and its `fileAnywayReason` bypass. */
  SUBJECT_DEDUPE: 'subject_dedupe',
  /** POST /api/tasks — `fileAnywayReason` itself refused (blank / wrong origin). */
  FILE_ANYWAY: 'file_anyway',
  /** POST /api/tasks — mission PR task with no concrete pathManifest. */
  MANIFEST_REQUIRED: 'manifest_required',
  /** Missions create/update — `branchStrategy` validation. */
  BRANCH_STRATEGY: 'branch_strategy',
  /** Missions create/update — `goalCriteria` validation, incl. notMechanizableReason. */
  GOAL_CRITERIA: 'goal_criteria',
  /** PATCH /api/workers/[id] — the outputRequirement completion gate, and `discardEdits`. */
  OUTPUT_REQUIREMENT: 'output_requirement',
  /** PATCH /api/workers/[id] — refusing to adopt a PR that targets the wrong base. */
  MISSION_BASE_ADOPTION: 'mission_base_adoption',
  /** create_pr — head is not the worker's own branch. */
  PR_HEAD_MISMATCH: 'pr_head_mismatch',
  /** create_pr — base disagrees with the mission integration branch. */
  PR_BASE_MISMATCH: 'pr_base_mismatch',
  /** merge_pr — workspace merge policy, and the admin `force` bypass. */
  MERGE_POLICY: 'merge_policy',
  /** merge_pr — mission-PR branch-lifecycle wait. */
  MISSION_PR_LIFECYCLE: 'mission_pr_lifecycle',
  /** Every merge door — an outstanding non-approve verdict, or a review round still in flight, at the commit being merged. Carries the human `override` bypass. */
  REVIEW_VERDICT: 'review_verdict',
  /** check_path_claim — wildcard refusal and real-overlap deferral. */
  PATH_CLAIM: 'path_claim',
  /** request_pr_review — one reviewer per PR at a time. */
  REVIEWER_SINGLE_FLIGHT: 'reviewer_single_flight',
  /** POST /api/workers/claim — a candidate task examined and deferred in the dispatch loop, or a claim attempt itself refused. Also carries the stranded-task sweep's `outcome: 'stranded'` rows. */
  CLAIM_LOOP_DEFERRAL: 'claim_loop_deferral',
  /** Mission goal-criteria evaluation resolving to NOT_EVALUATED/UNVERIFIED instead of a real verdict. */
  CRITERIA_NOT_EVALUATED: 'criteria_not_evaluated',
} as const;

export type GateSlug = (typeof GATE_SLUGS)[keyof typeof GATE_SLUGS];

export interface RecordGateEventInput {
  /** Stable rule slug — use a GATE_SLUGS constant. */
  gate: string;
  /** Route or tool that made the decision, e.g. 'POST /api/tasks'. */
  surface: string;
  outcome: GateOutcome;
  /**
   * The caller-facing message, RAW. It is normalized here — do not pre-normalize
   * at the call site, or two sites will disagree about what counts as the same
   * refusal.
   */
  reason: string;
  workspaceId?: string | null;
  missionId?: string | null;
  taskId?: string | null;
  workerId?: string | null;
  detail?: Record<string, unknown> | null;
  callerOrigin?: GateCallerOrigin | null;
}

/** UUID columns reject anything else; a non-UUID hint belongs in `detail`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

/** Keep a runaway payload out of the row; the reason already carries the shape. */
const MAX_DETAIL_CHARS = 4000;

function boundDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const json = JSON.stringify(detail);
    if (json.length <= MAX_DETAIL_CHARS) return detail;
    return { truncated: true, bytes: json.length, preview: json.slice(0, MAX_DETAIL_CHARS) };
  } catch {
    // Circular or otherwise unserializable — losing the detail is fine, losing
    // the event is not.
    return { unserializable: true };
  }
}

/**
 * Write one gate event. Fire-and-forget: never awaited by a request path, never
 * rejects, never throws.
 *
 * Returns the inserted row id when the write landed, or `null` when it did not
 * (the caller has no use for either — the return value exists so tests can
 * assert the write happened without reaching into the DB).
 */
export async function recordGateEvent(input: RecordGateEventInput): Promise<string | null> {
  try {
    const [row] = await db
      .insert(gateEvents)
      .values({
        gate: input.gate,
        surface: input.surface,
        outcome: input.outcome,
        reason: normalizeErrorSignature(input.reason),
        workspaceId: uuidOrNull(input.workspaceId),
        missionId: uuidOrNull(input.missionId),
        taskId: uuidOrNull(input.taskId),
        workerId: uuidOrNull(input.workerId),
        detail: boundDetail(input.detail),
        callerOrigin: input.callerOrigin ?? null,
      })
      .returning({ id: gateEvents.id });
    return row?.id ?? null;
  } catch (err) {
    // Deliberately swallowed. A console line is the whole escalation path: the
    // alternative is a ledger that can fail the very request it is observing.
    console.error(`[gate-ledger] failed to record ${input.gate}/${input.outcome}:`, err);
    return null;
  }
}

/**
 * Write a deferral event, coalescing repeats.
 *
 * The claim loop re-examines every pending task on every poll (seconds apart),
 * so a task stuck behind the same gate for hours would otherwise write one row
 * per poll forever. Instead: if the task's most recent gate event is a
 * `deferred` row with the SAME reason, bump its `detail.consecutiveDeferrals`
 * and `occurredAt` in place rather than inserting a new row. A different
 * reason (or no prior row) starts a fresh streak at 1 — the reason change
 * itself is the signal worth a new row for.
 *
 * `outcome` is required in `input` so this same coalescing shape can also
 * record `stranded` rows from the sweep (also collapsed by (taskId, reason)),
 * not just `deferred` ones from the claim loop.
 *
 * Falls back to a plain `recordGateEvent` insert when there's no `taskId` to
 * key the lookup on.
 */
export async function recordOrCoalesceDeferral(input: RecordGateEventInput): Promise<string | null> {
  const taskId = uuidOrNull(input.taskId);
  if (!taskId) return recordGateEvent(input);

  const normalizedReason = normalizeErrorSignature(input.reason);

  try {
    const [latest] = await db
      .select({ id: gateEvents.id, reason: gateEvents.reason, outcome: gateEvents.outcome, detail: gateEvents.detail })
      .from(gateEvents)
      .where(eq(gateEvents.taskId, taskId))
      .orderBy(desc(gateEvents.occurredAt))
      .limit(1);

    if (latest && latest.outcome === input.outcome && latest.reason === normalizedReason) {
      const priorDetail = (latest.detail as Record<string, unknown> | null) ?? {};
      const priorCount = typeof priorDetail.consecutiveDeferrals === 'number' ? priorDetail.consecutiveDeferrals : 1;
      // `occurredAt` moves forward on every coalesced poll, so it can never
      // answer "how long has this been stuck" — `firstDeferredAt` is the one
      // field that must survive every update untouched (spread order below:
      // priorDetail first, so a `firstDeferredAt` already on the row wins over
      // anything `input.detail` might carry).
      const firstDeferredAt = typeof priorDetail.firstDeferredAt === 'string' ? priorDetail.firstDeferredAt : new Date().toISOString();
      await db
        .update(gateEvents)
        .set({
          occurredAt: new Date(),
          detail: boundDetail({ ...priorDetail, ...(input.detail ?? {}), firstDeferredAt, consecutiveDeferrals: priorCount + 1 }),
        })
        .where(eq(gateEvents.id, latest.id));
      return latest.id;
    }

    return recordGateEvent({
      ...input,
      detail: { ...(input.detail ?? {}), firstDeferredAt: new Date().toISOString(), consecutiveDeferrals: 1 },
    });
  } catch (err) {
    console.error(`[gate-ledger] failed to coalesce ${input.gate}/${input.outcome}:`, err);
    return null;
  }
}
