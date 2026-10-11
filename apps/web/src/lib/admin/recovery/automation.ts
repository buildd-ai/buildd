/**
 * The `automation` block of the recovery panel (operator-recovery spec §8.3,
 * §8.4, §6.4): pause switches, recovery policy and today's model spend, read
 * from the `system_cache` keys the owner actions (B2) write.
 *
 * Read only. A failed read reports automation as paused with `readError: true`
 * (§8.3 fail closed), never as running.
 *
 * Pure.
 */
import type { RecoveryPanel, RecoveryPolicyView } from '@buildd/shared';
import { RECOVERY_BACKOFF_MINUTES, RECOVERY_BUDGET_LIMIT, RECOVERY_EPISODE_DEADLINE_MINUTES } from '@/lib/failure-incident-recovery';

export const OPERATOR_RECOVERY_KEY_PREFIX = 'operator-recovery:';
export const PAUSE_PLATFORM_KEY = 'operator-recovery:pause:platform';
export const PAUSE_RULE_PREFIX = 'operator-recovery:pause:rule:';
export const PAUSE_CAUSE_PREFIX = 'operator-recovery:pause:cause:';
export const POLICY_KEY = 'operator-recovery:policy';

/** §6.2 decision kinds. All start in shadow (B3). */
export const OPERATOR_RECOVERY_DECISION_KINDS = [
  'buildd.operator_cause_merge', 'buildd.operator_repair_suggestion', 'buildd.operator_priority_advice',
] as const;

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicyView = {
  v: 1,
  source: 'default',
  perRule: {
    path_overlap_stall: {
      budgetLimit: RECOVERY_BUDGET_LIMIT,
      backoffMinutes: RECOVERY_BACKOFF_MINUTES.slice(0, 3),
      episodeDeadlineHours: RECOVERY_EPISODE_DEADLINE_MINUTES / 60,
      autoRepair: 'on',
    },
  },
  model: { dailyUsd: 5, dailyCalls: 600, timeoutMs: 8000 },
};

type CacheRow = { key: string; value: unknown; expiresAt: Date | null };

function readPolicy(value: unknown): RecoveryPolicyView | null {
  const v = value as Partial<RecoveryPolicyView> | null;
  if (!v || v.v !== 1 || typeof v.perRule !== 'object' || typeof v.model !== 'object') return null;
  return { ...DEFAULT_RECOVERY_POLICY, ...v, perRule: { ...DEFAULT_RECOVERY_POLICY.perRule, ...v.perRule }, model: { ...DEFAULT_RECOVERY_POLICY.model, ...v.model }, source: 'stored' };
}

export function buildAutomationView(input: {
  /** Every `operator-recovery:*` row. Null: the read failed. */
  rows: CacheRow[] | null;
  model: { count: number; costUsd: number } | null;
  now: Date;
}): RecoveryPanel['automation'] {
  const model = { spentUsdToday: Math.round((input.model?.costUsd ?? 0) * 100) / 100, callsToday: input.model?.count ?? 0, breakerOpenUntil: null };
  if (input.rows === null) {
    return { paused: { platform: true, rules: [], causes: [] }, readError: true, policy: DEFAULT_RECOVERY_POLICY, model };
  }
  const live = input.rows.filter(r => !r.expiresAt || r.expiresAt > input.now);
  const policyRow = input.rows.find(r => r.key === POLICY_KEY);
  return {
    paused: {
      platform: live.some(r => r.key === PAUSE_PLATFORM_KEY),
      rules: live.filter(r => r.key.startsWith(PAUSE_RULE_PREFIX)).map(r => r.key.slice(PAUSE_RULE_PREFIX.length)).sort(),
      causes: live.filter(r => r.key.startsWith(PAUSE_CAUSE_PREFIX)).map(r => r.key.slice(PAUSE_CAUSE_PREFIX.length)).sort(),
    },
    readError: false,
    policy: (policyRow && readPolicy(policyRow.value)) || DEFAULT_RECOVERY_POLICY,
    model: { ...model, breakerOpenUntil: (() => {
      const b = live.find(r => r.key === 'operator-recovery:model-breaker');
      return b?.expiresAt ? b.expiresAt.toISOString() : null;
    })() },
  };
}
