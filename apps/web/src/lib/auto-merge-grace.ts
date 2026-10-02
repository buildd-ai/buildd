/**
 * When a just-green PR still belongs to the platform. Pure and client-safe:
 * the reviewer gate (server) and the mission pulse (client-bundled) import it.
 */
import { POLICY_DEFAULTS, policyValue } from './policy-overrides';

/**
 * How long a `ci_green` auto-threshold PR may stay open before it counts as held.
 * Public default; read the live value with `policyValue('autoMergeGreenGraceMs')`
 * (a client bundle always gets this default).
 */
export const AUTO_MERGE_GREEN_GRACE_MS = POLICY_DEFAULTS.autoMergeGreenGraceMs;

/**
 * THE "a green PR is still mid-merge" predicate. The check_suite webhook that
 * stamps `ci_green` calls the merge in the same delivery, so a PR that turned
 * green less than `AUTO_MERGE_GREEN_GRACE_MS` ago is the platform's, not the
 * owner's. The reviewer gate (home headline + Needs-you stat) and the mission
 * pulse (home mission rows, missions list, board) both read this -- one
 * definition, so a row can never say NEEDS YOU while the headline says nothing
 * does. No timestamp = no evidence of a fresh transition = held.
 */
export function isGreenAutoMergePending(
  prLifecycleStatus: string | null | undefined,
  prLifecycleUpdatedAt: Date | string | null | undefined,
  now: Date | number,
): boolean {
  if (prLifecycleStatus !== 'ci_green' || prLifecycleUpdatedAt == null) return false;
  const at = new Date(prLifecycleUpdatedAt).getTime();
  if (!Number.isFinite(at)) return false;
  const nowMs = typeof now === 'number' ? now : now.getTime();
  return nowMs - at < policyValue('autoMergeGreenGraceMs');
}
