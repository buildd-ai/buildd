/**
 * The kernel's effect handlers (docs/specs/workflow-kernel-library.md §2),
 * written against `KernelPorts` only and composed once by the host at
 * startup: `kernelEffectHandlers(ports)` is the handler map the drain
 * (`drainEffects`) runs for the kinds the package owns. A kind not listed in
 * `KERNEL_HANDLED_EFFECTS` is still the host's own handler.
 *
 * Two kinds are shared by families (`escalate_exhaustion` by `family`,
 * `cancel_open_attempts` by `reason`): the package answers the families it
 * owns and hands the rest to the host's handler for the kind (`host`).
 */
import type { EffectKind } from '../commands';
import type { EffectHandler, EffectHandlers } from '../effects';
import type { KernelPorts } from '../ports';
import { activityHandlers } from './activity';
import { ciHandlers, escalateCiExhaustion } from './ci';
import { landingHandlers } from './landing';
import { supersessionHandlers } from './supersession';
import { trunkHandlers } from './trunk';

export { activityHandlers } from './activity';
export { ciEvidenceFactKey, ciHandlers } from './ci';
export { landingHandlers } from './landing';
export { supersessionHandlers } from './supersession';
export { trunkFixDescription, trunkFixTitle, trunkHandlers, trunkSteerNote } from './trunk';

/** The effect kinds the package's handlers own (the shared kinds only for their own families). */
export const KERNEL_HANDLED_EFFECTS: readonly EffectKind[] = [
  'scan_supersession', 'project_supersession', 'wake_mission',
  'render_activity',
  'merge_call', 'verify_merge', 'emit_pr_merged', 'finalize_mission_pr',
  'dispatch_ci_fix', 'capture_ci_evidence', 'dispatch_trunk_fix',
  'escalate_exhaustion', 'cancel_open_attempts',
];

export function kernelEffectHandlers(ports: KernelPorts, host: EffectHandlers = {}): EffectHandlers {
  const trunk = trunkHandlers(ports);
  const toHost = (kind: EffectKind, fallback: string): EffectHandler => async (e) => (host[kind] ? host[kind]!(e) : { outcome: fallback });

  const escalateExhaustion: EffectHandler = async (e) => {
    if (e.payload.family !== 'ci') return toHost('escalate_exhaustion', 'skipped:no_handler')(e);
    return escalateCiExhaustion(ports, e, (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery);
  };
  const cancelOpenAttempts: EffectHandler = async (e) => (e.payload.reason === 'blocked_on_trunk'
    ? trunk.cancel_open_attempts!(e)
    : toHost('cancel_open_attempts', 'skipped:no_handler')(e));

  return {
    ...supersessionHandlers(ports),
    ...activityHandlers(ports),
    ...landingHandlers(ports),
    ...ciHandlers(ports),
    dispatch_trunk_fix: trunk.dispatch_trunk_fix,
    escalate_exhaustion: escalateExhaustion,
    cancel_open_attempts: cancelOpenAttempts,
  };
}
