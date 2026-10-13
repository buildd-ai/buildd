/**
 * Slice D's effects (docs/specs/workflow-state-kernel.md §10.2, T18/T20/T21):
 * what a closed PR's resolution owes after the kernel decided it. Each
 * handler re-reads the delivery and acts only on what is still owed; what the
 * host records and wakes is the `Lifecycle` port's.
 *
 *  - `scan_supersession` (T18): look for where a closed-unmerged PR's work
 *    landed. Detection only nominates; an edge it proves comes back as T20.
 *  - `project_supersession` (T20, T21): the resolution onto the host's records
 *    of the PR (§12: a projection, written only here).
 *  - `wake_mission` (T20, T21): whatever coordinates the owner may act now.
 */
import type { EffectHandler, EffectHandlers } from '../effects';
import type { KernelPorts } from '../ports';
import { hasPr, need } from './ports-of';

export function supersessionHandlers(ports: KernelPorts): EffectHandlers {
  const projectSupersession: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    if (d.state === 'SUPERSEDED' && d.supersededByPr != null) {
      const n = await need(ports, 'lifecycle', e.kind).projectResolution(d, 'superseded');
      return { outcome: `ok:superseded_${n}` };
    }
    if (d.state === 'ABANDONED') {
      const n = await need(ports, 'lifecycle', e.kind).projectResolution(d, 'abandoned');
      return { outcome: `ok:abandoned_${n}` };
    }
    return { outcome: `skipped:state_${d.state}` };
  };

  const wakeMission: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!d) return { outcome: 'skipped:no_delivery' };
    const r = await need(ports, 'lifecycle', e.kind).wakeCoordinator(d, 'pr_resolved');
    if (!r) return { outcome: 'skipped:no_mission' };
    return { outcome: r.woken ? 'ok:woken' : `ok:not_woken_${r.reason}` };
  };

  const scanSupersession: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    // Reopened, or already resolved by a person or an earlier scan: nothing to find.
    if (d.state !== 'CLOSED_UNMERGED') return { outcome: `skipped:state_${d.state}` };
    const r = await need(ports, 'lifecycle', e.kind).scanSupersession(d);
    if (r == null) return { outcome: 'skipped:no_worker' };
    return { outcome: `ok:${r}` };
  };

  return { scan_supersession: scanSupersession, project_supersession: projectSupersession, wake_mission: wakeMission };
}
