/**
 * The kernel's effect handlers (docs/specs/workflow-kernel-library.md §2),
 * written against `KernelPorts` only and composed once by the host at
 * startup: `kernelEffectHandlers(ports)` is the handler map the drain
 * (`drainEffects`) runs for the kinds the package owns. A kind not listed in
 * `KERNEL_HANDLED_EFFECTS` is still the host's own handler.
 */
import type { EffectKind } from '../commands';
import type { EffectHandlers } from '../effects';
import type { KernelPorts } from '../ports';
import { activityHandlers } from './activity';
import { landingHandlers } from './landing';
import { supersessionHandlers } from './supersession';

export { activityHandlers } from './activity';
export { landingHandlers } from './landing';
export { supersessionHandlers } from './supersession';

/** The effect kinds the package's handlers own. */
export const KERNEL_HANDLED_EFFECTS: readonly EffectKind[] = [
  'scan_supersession', 'project_supersession', 'wake_mission',
  'render_activity',
  'merge_call', 'verify_merge', 'emit_pr_merged', 'finalize_mission_pr',
];

export function kernelEffectHandlers(ports: KernelPorts): EffectHandlers {
  return { ...supersessionHandlers(ports), ...activityHandlers(ports), ...landingHandlers(ports) };
}
