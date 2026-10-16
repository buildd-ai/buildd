/**
 * The kernel's effect handlers (docs/specs/workflow-kernel-library.md §2),
 * written against `KernelPorts` only and composed once by the host at
 * startup: `kernelEffectHandlers(ports)` is the handler map the drain
 * (`drainEffects`) runs. Every effect kind the kernel records has its handler
 * here (`KERNEL_HANDLED_EFFECTS` = `EFFECT_KINDS`, less the host's own
 * projection `stamp_pr_rows`).
 *
 * Two kinds are shared by families: `escalate_exhaustion` (by `family`) and
 * `cancel_open_attempts` (by `reason`); each family's answer is below.
 */
import type { EffectKind } from '../commands';
import type { EffectHandler, EffectHandlers } from '../effects';
import type { KernelPorts } from '../ports';
import { activityHandlers } from './activity';
import { ciHandlers, escalateCiExhaustion } from './ci';
import { conflictHandlers, escalateConflictExhaustion } from './conflict';
import { landingHandlers } from './landing';
import { cancelReviewAttempts, escalateReviewExhaustion, reviewHandlers } from './review';
import { supersessionHandlers } from './supersession';
import { trunkHandlers } from './trunk';

export { activityHandlers } from './activity';
export { ciEvidenceFactKey, ciHandlers } from './ci';
export { conflictHandlers } from './conflict';
export { handOffToLegacyOn } from './hand-off';
export { externalMergeFixDescription, externalMergeFixTitle, landingHandlers } from './landing';
export { postReviewBody, pushRecoveryFollowupKey, reviewHandlers } from './review';
export { supersessionHandlers } from './supersession';
export { trunkFixDescription, trunkFixTitle, trunkHandlers, trunkSteerNote } from './trunk';

/** The effect kinds the package's handlers own: every kind but the host's `stamp_pr_rows` projection. */
export const KERNEL_HANDLED_EFFECTS: readonly EffectKind[] = [
  'scan_supersession', 'project_supersession', 'wake_mission',
  'render_activity',
  'merge_call', 'verify_merge', 'emit_pr_merged', 'finalize_mission_pr', 'publish_landing_status', 'dispatch_external_merge_fix',
  'dispatch_ci_fix', 'capture_ci_evidence', 'dispatch_trunk_fix',
  'dispatch_review', 'dispatch_fix', 'post_review', 'mission_note', 'notify', 'push_recovery', 'release_attribution', 'gate_event',
  'refresh_branch', 'renumber_migration', 'dispatch_conflict_fix',
  'escalate_exhaustion', 'cancel_open_attempts',
];

export function kernelEffectHandlers(ports: KernelPorts): EffectHandlers {
  const trunk = trunkHandlers(ports);

  const escalateExhaustion: EffectHandler = async (e) => {
    const family = e.payload.family;
    if (family !== 'ci' && family !== 'review_fix' && family !== 'conflict' && family !== 'migration') return { outcome: 'skipped:legacy_owns' };
    const view = await ports.store.loadView({ deliveryId: e.deliveryId });
    if (family === 'ci') return escalateCiExhaustion(ports, e, view.delivery);
    if (family === 'review_fix') return escalateReviewExhaustion(ports, e, view.delivery, view.rounds);
    return escalateConflictExhaustion(ports, e, view.delivery);
  };
  const cancelOpenAttempts: EffectHandler = async (e) => (e.payload.reason === 'blocked_on_trunk'
    ? trunk.cancel_open_attempts!(e)
    : cancelReviewAttempts(ports, e));

  return {
    ...supersessionHandlers(ports),
    ...activityHandlers(ports),
    ...landingHandlers(ports),
    ...ciHandlers(ports),
    ...reviewHandlers(ports),
    ...conflictHandlers(ports),
    dispatch_trunk_fix: trunk.dispatch_trunk_fix,
    escalate_exhaustion: escalateExhaustion,
    cancel_open_attempts: cancelOpenAttempts,
  };
}
