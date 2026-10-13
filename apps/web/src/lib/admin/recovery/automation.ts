/**
 * The `automation` block of the recovery panel (operator-recovery spec §8.3,
 * §8.4, §6.4): pause switches, recovery policy and today's model spend, read
 * from the `system_cache` keys the owner actions write
 * (`lib/failure-incident-recovery-automation.ts` owns the keys and the policy).
 *
 * Read only. A failed read reports automation as paused with `readError: true`
 * (§8.3 fail closed), never as running.
 *
 * Pure.
 */
import type { RecoveryPanel } from '@buildd/shared';
import { buildAutomationState, type AutomationRow } from '@/lib/failure-incident-recovery-automation';

export {
  DEFAULT_RECOVERY_POLICY, OPERATOR_RECOVERY_KEY_PREFIX, PAUSE_CAUSE_PREFIX, PAUSE_PLATFORM_KEY, PAUSE_RULE_PREFIX, POLICY_KEY,
} from '@/lib/failure-incident-recovery-automation';

/** §6.2 decision kinds. All start in shadow (B3). */
export const OPERATOR_RECOVERY_DECISION_KINDS = [
  'buildd.operator_cause_merge', 'buildd.operator_repair_suggestion', 'buildd.operator_priority_advice',
] as const;

const MODEL_BREAKER_KEY = 'operator-recovery:model-breaker';

export function buildAutomationView(input: {
  /** Every `operator-recovery:*` row. Null: the read failed. */
  rows: Array<Omit<AutomationRow, 'updatedAt'> & { updatedAt?: Date }> | null;
  model: { count: number; costUsd: number } | null;
  now: Date;
}): RecoveryPanel['automation'] {
  const model = { spentUsdToday: Math.round((input.model?.costUsd ?? 0) * 100) / 100, callsToday: input.model?.count ?? 0, breakerOpenUntil: null as string | null };
  const state = buildAutomationState(input.rows === null ? null : input.rows.map(r => ({ ...r, updatedAt: r.updatedAt ?? input.now })), input.now);
  if (input.rows !== null) {
    const breaker = input.rows.find(r => r.key === MODEL_BREAKER_KEY && r.expiresAt && r.expiresAt > input.now);
    model.breakerOpenUntil = breaker?.expiresAt ? breaker.expiresAt.toISOString() : null;
  }
  return {
    paused: { platform: state.paused.platform, rules: state.paused.rules, causes: state.paused.causes },
    readError: state.readError,
    policy: state.policy,
    model,
  };
}
