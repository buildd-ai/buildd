/**
 * Operator recovery automation: the kill switch, pause scopes and policy
 * (operator-recovery spec §8.3, §8.4, §9.5, operator console).
 *
 * Stored in `system_cache`:
 *  - `operator-recovery:pause:platform`, `:pause:rule:<rule>`,
 *    `:pause:cause:<causeKey>`, `:pause:model` → `{ until, by, reason, auditId }`,
 *    with `expiresAt = until` so a pause lapses on its own.
 *  - `operator-recovery:policy` → `{ v: 1, perRule, model, perRepair? }`.
 * Writes compare-and-set on `updatedAt`.
 *
 * The recovery loop reads this before every automatic repair
 * (`automationGate`). A failed read is paused (fail closed): detection,
 * assessment and verification go on, repairs do not.
 *
 * Pure, except the `db*` functions at the bottom.
 */
import type { FailureIncidentRule, RecoveryPolicyView } from '@buildd/shared';
import type { RecoveryRepairAction } from './failure-incident-recovery';
import type { RepairKind } from './failure-incident-recovery-events';

export const OPERATOR_RECOVERY_KEY_PREFIX = 'operator-recovery:';
export const PAUSE_PLATFORM_KEY = 'operator-recovery:pause:platform';
export const PAUSE_RULE_PREFIX = 'operator-recovery:pause:rule:';
export const PAUSE_CAUSE_PREFIX = 'operator-recovery:pause:cause:';
export const PAUSE_MODEL_KEY = 'operator-recovery:pause:model';
export const POLICY_KEY = 'operator-recovery:policy';

/** §8.1: a pause lasts at most this long. */
export const MAX_PAUSE_MS = 7 * 86_400_000;

export type AutoRepairMode = 'off' | 'shadow' | 'on';

export type PauseScope =
  | { kind: 'platform' }
  | { kind: 'rule'; rule: string }
  | { kind: 'cause'; causeKey: string }
  | { kind: 'model' };

export interface PauseValue { until: string; by: string; reason: string; auditId: string | null }

export function pauseKey(scope: PauseScope): string {
  switch (scope.kind) {
    case 'platform': return PAUSE_PLATFORM_KEY;
    case 'model': return PAUSE_MODEL_KEY;
    case 'rule': return `${PAUSE_RULE_PREFIX}${scope.rule}`;
    case 'cause': return `${PAUSE_CAUSE_PREFIX}${scope.causeKey}`;
  }
}

// ── Policy (§8.4) ───────────────────────────────────────────────────────────

export type RulePolicy = RecoveryPolicyView['perRule'][string];

/**
 * The repair families FIR shipped run automatically; any other family starts
 * in shadow (§9.5) until a `set_policy` turns it on.
 */
const LIVE_RULES: ReadonlySet<string> = new Set<FailureIncidentRule>(['path_overlap_stall', 'infrastructure_failure']);

export const DEFAULT_RULE_POLICY: Omit<RulePolicy, 'autoRepair'> = {
  budgetLimit: 3,
  backoffMinutes: [5, 15, 45],
  episodeDeadlineHours: 6,
};

/**
 * Repairs added by B2 start in shadow (§9.5): the loop records what it would
 * run and runs nothing. FIR's own actions keep running as they shipped.
 */
export const DEFAULT_ACTION_ROLLOUT: Record<RecoveryRepairAction, AutoRepairMode> = {
  release_blocker: 'on',
  wake_subject: 'on',
  file_fix_task: 'on',
  release_hold: 'on',
  retry_capture: 'on',
  redeliver_dispatch: 'shadow',
  retry_stale_worker: 'shadow',
  rerun_visual_audit: 'shadow',
  kernel_ci_retry: 'shadow',
};

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicyView = {
  v: 1,
  source: 'default',
  perRule: {
    path_overlap_stall: { ...DEFAULT_RULE_POLICY, autoRepair: 'on' },
    infrastructure_failure: { ...DEFAULT_RULE_POLICY, autoRepair: 'on' },
  },
  // 800 ms per question, the escalation gate's deadline: the owner wants hundreds of ms, not seconds (B3).
  model: { dailyUsd: 5, dailyCalls: 600, timeoutMs: 800 },
};

/** §8.4 bounds. Validated on every `set_policy`; nothing outside them is stored. */
export const POLICY_BOUNDS = {
  budgetLimit: [1, 5],
  backoffMinute: [2, 240],
  backoffSteps: [1, 6],
  episodeDeadlineHours: [1, 48],
  dailyUsd: [0, 25],
  dailyCalls: [0, 2000],
  timeoutMs: [200, 800],
} as const;

const MODES: readonly AutoRepairMode[] = ['off', 'shadow', 'on'];

export function rulePolicy(policy: RecoveryPolicyView, rule: string): RulePolicy {
  return policy.perRule[rule] ?? { ...DEFAULT_RULE_POLICY, autoRepair: LIVE_RULES.has(rule) ? 'on' : 'shadow' };
}

/** A stored value as a policy, or null when it is not a v1 one. Missing fields take the defaults. */
export function readPolicy(value: unknown): RecoveryPolicyView | null {
  const v = value as Partial<RecoveryPolicyView> | null;
  if (!v || v.v !== 1 || typeof v.perRule !== 'object' || v.perRule === null || typeof v.model !== 'object' || v.model === null) return null;
  return {
    v: 1,
    source: 'stored',
    perRule: { ...DEFAULT_RECOVERY_POLICY.perRule, ...v.perRule },
    model: { ...DEFAULT_RECOVERY_POLICY.model, ...v.model },
    ...(v.perRepair ? { perRepair: { ...v.perRepair } } : {}),
  };
}

export interface PolicyPatch {
  rule?: string;
  budgetLimit?: number;
  backoffMinutes?: number[];
  episodeDeadlineHours?: number;
  autoRepair?: AutoRepairMode;
  repair?: { kind: RepairKind; mode: AutoRepairMode };
  model?: Partial<RecoveryPolicyView['model']>;
}

const inRange = (n: unknown, [lo, hi]: readonly [number, number]) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
const isInt = (n: unknown) => typeof n === 'number' && Number.isInteger(n);

/**
 * Pure. The policy after `patch`, or the first bound it breaks (§8.4). A rule
 * patch needs `rule`; model fields stand alone. The result is what gets stored.
 */
export function applyPolicyPatch(current: RecoveryPolicyView, patch: PolicyPatch): { ok: true; policy: RecoveryPolicyView } | { ok: false; error: string } {
  const B = POLICY_BOUNDS;
  const ruleFields = patch.budgetLimit !== undefined || patch.backoffMinutes !== undefined || patch.episodeDeadlineHours !== undefined || patch.autoRepair !== undefined;
  if (ruleFields && !patch.rule) return { ok: false, error: 'rule is required for budgetLimit, backoffMinutes, episodeDeadlineHours and autoRepair' };
  if (patch.budgetLimit !== undefined && !(isInt(patch.budgetLimit) && inRange(patch.budgetLimit, B.budgetLimit))) return { ok: false, error: `budgetLimit must be an integer from ${B.budgetLimit[0]} to ${B.budgetLimit[1]}` };
  if (patch.backoffMinutes !== undefined) {
    const steps = patch.backoffMinutes;
    if (!Array.isArray(steps) || !inRange(steps.length, B.backoffSteps) || !steps.every(m => inRange(m, B.backoffMinute))) {
      return { ok: false, error: `backoffMinutes must be ${B.backoffSteps[0]} to ${B.backoffSteps[1]} values, each from ${B.backoffMinute[0]} to ${B.backoffMinute[1]}` };
    }
  }
  if (patch.episodeDeadlineHours !== undefined && !inRange(patch.episodeDeadlineHours, B.episodeDeadlineHours)) return { ok: false, error: `episodeDeadlineHours must be from ${B.episodeDeadlineHours[0]} to ${B.episodeDeadlineHours[1]}` };
  if (patch.autoRepair !== undefined && !MODES.includes(patch.autoRepair)) return { ok: false, error: 'autoRepair must be off, shadow or on' };
  if (patch.repair !== undefined && !MODES.includes(patch.repair.mode)) return { ok: false, error: 'repair.mode must be off, shadow or on' };
  const m = patch.model ?? {};
  if (m.dailyUsd !== undefined && !inRange(m.dailyUsd, B.dailyUsd)) return { ok: false, error: `model.dailyUsd must be from ${B.dailyUsd[0]} to ${B.dailyUsd[1]}` };
  if (m.dailyCalls !== undefined && !(isInt(m.dailyCalls) && inRange(m.dailyCalls, B.dailyCalls))) return { ok: false, error: `model.dailyCalls must be an integer from ${B.dailyCalls[0]} to ${B.dailyCalls[1]}` };
  if (m.timeoutMs !== undefined && !(isInt(m.timeoutMs) && inRange(m.timeoutMs, B.timeoutMs))) return { ok: false, error: `model.timeoutMs must be an integer from ${B.timeoutMs[0]} to ${B.timeoutMs[1]}` };

  const perRule = { ...current.perRule };
  if (patch.rule && ruleFields) {
    const prior = rulePolicy(current, patch.rule);
    perRule[patch.rule] = {
      budgetLimit: patch.budgetLimit ?? prior.budgetLimit,
      backoffMinutes: patch.backoffMinutes ? [...patch.backoffMinutes] : prior.backoffMinutes,
      episodeDeadlineHours: patch.episodeDeadlineHours ?? prior.episodeDeadlineHours,
      autoRepair: patch.autoRepair ?? prior.autoRepair,
    };
  }
  const perRepair = patch.repair ? { ...(current.perRepair ?? {}), [patch.repair.kind]: patch.repair.mode } : current.perRepair;
  return {
    ok: true,
    policy: { v: 1, source: 'stored', perRule, model: { ...current.model, ...m }, ...(perRepair ? { perRepair } : {}) },
  };
}

// ── State and the gate ──────────────────────────────────────────────────────

export interface AutomationRow { key: string; value: unknown; updatedAt: Date; expiresAt: Date | null }

export interface AutomationState {
  /** The read failed: everything reads as paused (§8.3 fail closed). */
  readError: boolean;
  paused: { platform: boolean; rules: string[]; causes: string[]; model: boolean };
  policy: RecoveryPolicyView;
  /** Every live row's `updatedAt` (ISO, ms), the CAS token for its next write. Missing: no row. */
  revisions: Record<string, string>;
  pauses: Record<string, PauseValue>;
}

export function buildAutomationState(rows: AutomationRow[] | null, now: Date): AutomationState {
  if (rows === null) {
    return { readError: true, paused: { platform: true, rules: [], causes: [], model: true }, policy: DEFAULT_RECOVERY_POLICY, revisions: {}, pauses: {} };
  }
  const live = rows.filter(r => r.key === POLICY_KEY || !r.expiresAt || r.expiresAt > now);
  const policyRow = live.find(r => r.key === POLICY_KEY);
  const pauses: Record<string, PauseValue> = {};
  for (const r of live) if (r.key.includes(':pause:')) pauses[r.key] = r.value as PauseValue;
  return {
    readError: false,
    paused: {
      platform: !!pauses[PAUSE_PLATFORM_KEY],
      rules: Object.keys(pauses).filter(k => k.startsWith(PAUSE_RULE_PREFIX)).map(k => k.slice(PAUSE_RULE_PREFIX.length)).sort(),
      causes: Object.keys(pauses).filter(k => k.startsWith(PAUSE_CAUSE_PREFIX)).map(k => k.slice(PAUSE_CAUSE_PREFIX.length)).sort(),
      model: !!pauses[PAUSE_MODEL_KEY],
    },
    policy: (policyRow && readPolicy(policyRow.value)) || DEFAULT_RECOVERY_POLICY,
    revisions: Object.fromEntries(live.map(r => [r.key, r.updatedAt.toISOString()])),
    pauses,
  };
}

/** The pause that holds for this rule or cause, most general first; null when none. */
export function pauseFor(state: AutomationState, at: { rule: string; causeKey: string | null }): PauseScope | null {
  if (state.readError || state.paused.platform) return { kind: 'platform' };
  if (state.paused.rules.includes(at.rule)) return { kind: 'rule', rule: at.rule };
  if (at.causeKey && state.paused.causes.includes(at.causeKey)) return { kind: 'cause', causeKey: at.causeKey };
  return null;
}

export function actionMode(policy: RecoveryPolicyView, rule: string, action: RecoveryRepairAction, kind: RepairKind): AutoRepairMode {
  const ruleMode = rulePolicy(policy, rule).autoRepair;
  const repairMode = (policy.perRepair?.[kind] as AutoRepairMode | undefined) ?? DEFAULT_ACTION_ROLLOUT[action];
  // The stricter of the family's switch and the repair's own rollout.
  return MODES[Math.min(MODES.indexOf(ruleMode), MODES.indexOf(repairMode))];
}

export type AutomationVerdict =
  | { run: true }
  | { run: false; why: 'paused'; scope: PauseScope; label: string }
  | { run: false; why: 'shadow' | 'off'; label: string };

/** Pure. May the loop run this repair on its own now? */
export function automationGate(state: AutomationState, at: { rule: string; causeKey: string | null; action: RecoveryRepairAction; kind: RepairKind }): AutomationVerdict {
  const scope = pauseFor(state, at);
  if (scope) {
    const what = state.readError ? 'the pause switch could not be read' : scope.kind === 'platform' ? 'the operator paused automatic repairs' : `the operator paused automatic repairs for this ${scope.kind === 'rule' ? 'kind of problem' : 'problem'}`;
    return { run: false, why: 'paused', scope, label: `Automatic repair is on hold: ${what}. Buildd keeps checking.` };
  }
  const mode = actionMode(state.policy, at.rule, at.action, at.kind);
  if (mode === 'on') return { run: true };
  return {
    run: false,
    why: mode,
    label: mode === 'shadow'
      ? 'Buildd recorded the repair it would run; this repair is still being trialled, so nothing ran. Buildd keeps checking.'
      : 'Automatic repair is switched off for this kind of problem. Buildd keeps checking.',
  };
}

// ── DB ──────────────────────────────────────────────────────────────────────

/** Every `operator-recovery:*` row, or the fail-closed state when the read fails. */
export async function readAutomationState(now: Date = new Date()): Promise<AutomationState> {
  try {
    const [{ db }, { systemCache }, { like }] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
    const rows = await db.select({ key: systemCache.key, value: systemCache.value, updatedAt: systemCache.updatedAt, expiresAt: systemCache.expiresAt })
      .from(systemCache).where(like(systemCache.key, `${OPERATOR_RECOVERY_KEY_PREFIX}%`));
    return buildAutomationState(rows, now);
  } catch (err) {
    console.error('[operator-recovery] automation read failed, treating as paused:', err instanceof Error ? err.message : err);
    return buildAutomationState(null, now);
  }
}

/**
 * Compare-and-set one key on `updatedAt` (ms precision). `expected` null: the
 * key must not exist (or have expired, for a pause). `value` null deletes.
 * Returns the new `updatedAt`, or null when someone else wrote first.
 */
export async function compareAndSetAutomation(input: {
  key: string; value: unknown | null; expected: string | null; expiresAt: Date | null; now?: Date;
}): Promise<string | null> {
  const [{ db }, { systemCache }, { and, eq, sql }] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
  const now = new Date(Math.floor((input.now ?? new Date()).getTime()));
  const sameStamp = (expected: string) => sql`date_trunc('milliseconds', ${systemCache.updatedAt}) = ${expected}::timestamptz`;
  if (input.value === null) {
    if (!input.expected) return null;
    const rows = await db.delete(systemCache).where(and(eq(systemCache.key, input.key), sameStamp(input.expected))).returning({ key: systemCache.key });
    return rows.length ? now.toISOString() : null;
  }
  if (input.expected === null) {
    // New, or replacing a lapsed pause (an expired row reads as absent).
    const rows = await db.insert(systemCache)
      .values({ key: input.key, value: input.value, updatedAt: now, expiresAt: input.expiresAt })
      .onConflictDoUpdate({
        target: systemCache.key,
        set: { value: input.value, updatedAt: now, expiresAt: input.expiresAt },
        setWhere: sql`${systemCache.expiresAt} IS NOT NULL AND ${systemCache.expiresAt} <= now()`,
      })
      .returning({ key: systemCache.key });
    return rows.length ? now.toISOString() : null;
  }
  const rows = await db.update(systemCache)
    .set({ value: input.value, updatedAt: now, expiresAt: input.expiresAt })
    .where(and(eq(systemCache.key, input.key), sameStamp(input.expected)))
    .returning({ key: systemCache.key });
  return rows.length ? now.toISOString() : null;
}
