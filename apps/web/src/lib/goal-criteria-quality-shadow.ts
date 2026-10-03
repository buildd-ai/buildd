/**
 * Runs the `mission_goal_quality` verdict (lib/goal-criteria-quality-decision.ts)
 * for a goal-criteria write that POST /api/missions or PATCH
 * /api/missions/[id] has already committed.
 *
 * In `shadow` (the shipped mode) always after the response: `after()` when a
 * request scope exists, else an unawaited promise. So it can never slow or fail
 * the write, and nothing it finds reaches the response. In `surface` the route
 * awaits it for at most `GOAL_QUALITY_TIMEOUT_MS` and attaches an `advisory`
 * when it lands in time (`withGoalQualityAdvisory`); the mode is a parameter
 * here so tests can drive it while the constant stays `shadow`.
 *
 * Weak criteria are recorded as `warned` rows in the gate ledger. On a PATCH, a
 * criterion that was warned before and is still present is recorded once as
 * `bypassed`, by fingerprint, whether or not the capability is on.
 *
 * The workspace's `dataClass` is read here, in the background, when the route
 * did not already have it, and that read fails CLOSED: if we cannot tell
 * whether a workspace is sensitive, nothing is sent.
 */
import { after } from 'next/server';
import type { GoalCriterion } from '@buildd/shared';
import type { GateCallerOrigin, RecordGateEventInput } from '@buildd/core/gate-events';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import {
  GOAL_QUALITY_MODE,
  GOAL_QUALITY_REWRITES,
  GOAL_QUALITY_TIMEOUT_MS,
  adviseGoalQuality,
  goalQualityBypasses,
  goalQualityWarnings,
  gradedCriteria,
  type GoalQualityDeps,
  type GoalQualityLedgerRow,
  type GoalQualityVerdict,
  type RewriteLabel,
} from './goal-criteria-quality-decision';

export type GoalQualityMode = 'shadow' | 'surface';

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
  /** The mission's prior `warned` / `bypassed` rows for this gate. */
  loadLedger?: (missionId: string) => Promise<GoalQualityLedgerRow[]>;
  /** Defaults to `GOAL_QUALITY_MODE`; a parameter only so tests can drive `surface`. */
  mode?: GoalQualityMode;
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

/** Bounded: one gate's rows for one mission, newest first. */
const LEDGER_READ_LIMIT = 500;

async function defaultLoadLedger(missionId: string): Promise<GoalQualityLedgerRow[]> {
  const [{ db }, { gateEvents }, { and, desc, eq, inArray }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
  ]);
  return db
    .select({ outcome: gateEvents.outcome, detail: gateEvents.detail })
    .from(gateEvents)
    .where(and(
      eq(gateEvents.gate, GATE_SLUGS.GOAL_CRITERIA_QUALITY),
      eq(gateEvents.missionId, missionId),
      inArray(gateEvents.outcome, ['warned', 'bypassed']),
    ))
    .orderBy(desc(gateEvents.occurredAt))
    .limit(LEDGER_READ_LIMIT);
}

function fireAll(rows: readonly RecordGateEventInput[], opts: GoalQualityShadowOpts): void {
  for (const row of rows) {
    try {
      if (opts.fire) opts.fire(row);
      else void defaultFire(row).catch(() => {});
    } catch {
      // The ledger is observability; it never fails anything.
    }
  }
}

/** Never throws: a failed read records nothing. */
async function recordBypasses(input: GoalQualityShadowInput, criteria: GoalCriterion[], opts: GoalQualityShadowOpts): Promise<void> {
  try {
    const prior = await (opts.loadLedger ?? defaultLoadLedger)(input.missionId);
    if (!Array.isArray(prior) || prior.length === 0) return;
    fireAll(goalQualityBypasses(criteria, prior, {
      missionId: input.missionId,
      workspaceId: input.workspaceId,
      surface: input.surface,
      callerOrigin: input.callerOrigin ?? null,
    }), opts);
  } catch {
    // No bypass row is better than a guessed one.
  }
}

/** The work itself. Never throws; null when there is no verdict. */
export async function runGoalQualityShadow(input: GoalQualityShadowInput, opts: GoalQualityShadowOpts = {}): Promise<GoalQualityVerdict | null> {
  try {
    if (!Array.isArray(input.criteria) || input.criteria.length === 0) return null;
    const criteria = input.criteria as GoalCriterion[];
    const mode = opts.mode ?? GOAL_QUALITY_MODE;
    // Before the verdict: this write's own warnings are not prior ones.
    if (input.surface === 'PATCH /api/missions/[id]') await recordBypasses(input, criteria, opts);
    if (gradedCriteria(criteria, input.stored).length === 0) return null;

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
      criteria,
      stored: input.stored,
      mode,
    }, opts.deps);
    if (!verdict) return null;
    const rows = goalQualityWarnings(verdict, {
      missionId: input.missionId,
      workspaceId: input.workspaceId,
      surface: input.surface,
      callerOrigin: input.callerOrigin ?? null,
      mode,
    });
    fireAll(rows, opts);
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

// ── Surface ──────────────────────────────────────────────────────────────────

/** What a `surface` response carries. Labels and code-owned text only. */
export interface GoalQualityAdvisory {
  promptVersion: string;
  /** Every criterion this write added or changed, by position in the submitted array. */
  criteria: Array<{
    index: number;
    fingerprint: string;
    type: GoalCriterion['type'];
    /** Names something a user would notice. False for bookkeeping. */
    outcome: boolean;
    checkable: boolean;
    weak: boolean;
  }>;
  /** The one rewrite, rendered from the code-owned table. */
  rewrite: Exclude<RewriteLabel, 'none'>;
  suggestion: string;
}

/**
 * The advisory for a verdict, or null when nothing is weak. Exactly one
 * suggestion: the model's rewrite label, or — when it picked `none` while
 * still grading something weak — the one that fits the first weak criterion.
 */
export function goalQualityAdvisory(verdict: GoalQualityVerdict): GoalQualityAdvisory | null {
  const firstWeak = verdict.criteria.find(c => c.weak);
  if (!firstWeak) return null;
  const rewrite: Exclude<RewriteLabel, 'none'> = verdict.rewrite !== 'none'
    ? verdict.rewrite
    : firstWeak.weakOn.includes('noticeable') ? 'state-outcome' : 'command-proof';
  return {
    promptVersion: verdict.promptVersion,
    criteria: verdict.criteria.map(c => ({
      index: c.index,
      fingerprint: c.fingerprint,
      type: c.type,
      outcome: c.noticeable === 'yes',
      checkable: c.checkable === 'yes',
      weak: c.weak,
    })),
    rewrite,
    suggestion: GOAL_QUALITY_REWRITES[rewrite]!,
  };
}

/**
 * The response body for a goal-criteria write. `shadow`: the body, unchanged
 * (the same object), with the verdict scheduled after the response. `surface`:
 * waits at most `timeoutMs` and adds `advisory` when the verdict landed and
 * something is weak; on a miss the body is unchanged and the work still
 * finishes after the response, so the ledger rows land. Never throws, never
 * touches the criteria in the body or the store.
 */
export async function withGoalQualityAdvisory<T extends object>(
  body: T,
  input: GoalQualityShadowInput,
  opts: GoalQualityShadowOpts & { timeoutMs?: number } = {},
): Promise<T | (T & { advisory: GoalQualityAdvisory })> {
  const mode = opts.mode ?? GOAL_QUALITY_MODE;
  if (mode !== 'surface') {
    scheduleGoalQualityShadow(input, opts);
    return body;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = runGoalQualityShadow(input, { ...opts, mode });
    try {
      (opts.schedule ?? after)(() => run);
    } catch {
      // Outside a request scope the promise simply runs on.
    }
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs ?? GOAL_QUALITY_TIMEOUT_MS);
    });
    const verdict = await Promise.race([run, deadline]);
    const advisory = verdict ? goalQualityAdvisory(verdict) : null;
    return advisory ? { ...body, advisory } : body;
  } catch {
    return body;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
